#!/usr/bin/env node
// Drives the LLM agent: POST /api/agent/run on a fixed interval for the whole
// scoring window, then stops. This is the "external cron" docs/08-agent.md
// refers to — run it under pm2 / systemd / nohup on any always-on box.
//
//   node scripts/agent-runner.mjs
//   AGENT_RUN_URL=https://my-host/api/agent/run MCP_AUTH_TOKEN=… node scripts/agent-runner.mjs
//
// Env:
//   AGENT_RUN_URL        default http://localhost:3000/api/agent/run
//   MCP_AUTH_TOKEN       sent as `Authorization: Bearer …` when set
//   AGENT_RUNNER_MS      cycle interval, default 60000, min 15000
//   AGENT_RUNNER_UNTIL   ISO stop time, default 2026-09-03T20:05:00Z (snapshot + 5 min)
//
// Run it detached, or it dies with the terminal that launched it:
//   nohup pnpm agent:run >> agent-runner.log 2>&1 &
//
// The endpoint gates itself (scoring window, one entry per ET day, AGENT_ENABLED),
// so it is safe to call every minute for the full window — most calls just run
// the manage pass and return "entry not evaluated".

const URL = process.env.AGENT_RUN_URL ?? "http://localhost:3000/api/agent/run";
const TOKEN = process.env.MCP_AUTH_TOKEN;
const INTERVAL_MS = Math.max(15_000, Number(process.env.AGENT_RUNNER_MS ?? "60000") || 60_000);
const UNTIL = Date.parse(process.env.AGENT_RUNNER_UNTIL ?? "2026-09-03T20:05:00.000Z");
// Generous: a cycle with two dead-zone spreads makes two ~45s reasoning calls.
// Well short of forever, which is what it was.
const REQUEST_TIMEOUT_MS = Math.max(INTERVAL_MS * 4, 240_000);

let stopping = false;
let wakeEarly = () => {};
let consecutiveErrors = 0;

/** Sleep that returns immediately when a signal asks us to stop. */
const sleep = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wakeEarly = () => {
      clearTimeout(t);
      resolve();
    };
  });

const log = (...a) => console.log(new Date().toISOString(), ...a);

function summarize(report) {
  const e = report.entry ?? {};
  const entry = !e.evaluated
    ? `entry: skip (${e.reason})`
    : e.acted
      ? `entry: OPENED ${e.orderId}`
      : `entry: no-trade (${e.skipped ?? e.error ?? "?"})`;
  const managed = (report.managed ?? []).map((m) => `${m.zone}->${m.action}`).join(", ");
  const errors = (report.errors ?? []).length ? ` errors: ${report.errors.join("; ")}` : "";
  return `[${report.phase}] ${entry}${managed ? ` | managed: ${managed}` : ""}${errors}`;
}

async function runOnce() {
  // A cycle that never answers must not take the loop down with it. `fetch` has
  // no default timeout, so without this one hung request — a wedged LLM call, a
  // stalled Alpaca socket — parks the runner forever and the agent silently
  // stops trading for the rest of the competition.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(URL, {
      method: "POST",
      headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(
      controller.signal.aborted
        ? `no response within ${REQUEST_TIMEOUT_MS / 1000}s — abandoning this cycle`
        : err.message,
    );
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${body.error ?? JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

async function loop() {
  log(`agent-runner: ${URL} every ${INTERVAL_MS / 1000}s until ${new Date(UNTIL).toISOString()}`);

  while (!stopping) {
    if (Date.now() > UNTIL) {
      log("past the stop time — exiting");
      break;
    }

    const started = Date.now();
    try {
      const report = await runOnce();
      consecutiveErrors = 0;
      log(summarize(report));
    } catch (err) {
      consecutiveErrors += 1;
      log(`cycle failed (${consecutiveErrors} in a row): ${err.message}`);
    }

    // Back off on a run of failures, but never longer than 5 minutes and never
    // shorter than the configured interval.
    const backoff =
      consecutiveErrors > 1
        ? Math.min(300_000, INTERVAL_MS * 2 ** Math.min(consecutiveErrors - 1, 3))
        : INTERVAL_MS;
    const wait = Math.max(1_000, backoff - (Date.now() - started));
    await sleep(wait);
  }
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`${sig} — stopping`);
    stopping = true;
    wakeEarly();
  });
}

loop().then(() => process.exit(0));
