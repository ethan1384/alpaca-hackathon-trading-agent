# LLM decision agent — SPY put credit spread

> **ARCHIVED — 2026-09-10.** This agent traded the hackathon (2026-08-31 →
> 2026-09-03) and is frozen at git tag **`archive/credit-spread-agent`**
> (`git checkout archive/credit-spread-agent` restores it exactly). The code
> below is still in the tree and still wired to `/api/agent/run`, but it can no
> longer open a position: `runEntry` refuses outside the scoring window, which
> has closed. `.github/workflows/agent-cron.yml` still calls the endpoint — a
> no-op, to be disabled. The strategy under study is now the ascending-triangle
> breakout: see `docs/09-strategie-triangle.md`.

Module: `src/server/agent/` · Config: `src/config/agent.ts` (+ LLM endpoint in
`src/config/env.ts`) · Routes: `/api/agent/{run,status,decisions}` · MCP:
`run_agent_cycle`, `get_agent_status` · UI: dashboard **Agent** tab.

Read `docs/07-strategie-credit-spreads.md` first — this agent trades that
structure live. The analysis there concluded the LLM's job on the credit spread
is **not** to manage the stop (a fixed parameter) but two narrow interventions.

---

## 1. What it does

A **mechanical** put-credit-spread on SPY:

| | value | source |
| --- | --- | --- |
| structure | sell ~0.175-delta put / buy the put $5 lower | `AGENT.targetDelta` / `spreadWidth` |
| DTE | 1–2, never past the 2026-09-03 snapshot | `AGENT.minDte/maxDte` + `isExpirationWithinWindow` |
| entry | once per ET session, 10:00–11:00 ET | `AGENT.entryWindowEt` |
| min credit | 0.25 after cushion (implicit IV floor) | `AGENT.minCredit` |
| min credit/width | 0.10 on the post-cushion credit — rejects negative-EV thin spreads (see docs/07 §7) | `AGENT.minCreditRatio` |
| size | 1% of equity max-loss per spread, ≤ 2 concurrent | `AGENT.riskPerSidePct` / `maxConcurrentSpreads` |
| profit target | buy back at 50% of credit | `AGENT.targetProfitPct` — **mechanical** |
| stop | buy back at 3× credit | `AGENT.stopMultiple` — **mechanical** |
| time close | 15:30 ET on expiry day, or 30 min to expiry | `AGENT.timeCloseEt` — **mechanical** |
| forced close | 45 min before the 20:00Z equity snapshot | `AGENT.forceCloseMinutesBeforeSnapshot` — **mechanical** |

The **LLM** adds exactly two things and nothing else:

1. **Entry veto** — at the entry window, approve or skip the mechanically chosen
   spread, reasoning about scheduled macro events (CPI/FOMC/NFP) landing before
   expiry, a trend breaking toward the short strike, and whether IV pays for the
   tail. The tail loss here is a gap through the short strike.
2. **Dead-zone early close** — for an open spread that is *losing* AND (near the
   short strike OR low on time), decide close-now-for-a-small-loss vs hold. The
   3× stop is still armed underneath.

The stop / target / time-close / deadline are code. The model is never asked
about them and cannot widen or remove them.

---

## 2. Running it

`POST /api/agent/run` executes **one cycle**: manage every open spread, then (if
in the entry window) evaluate an entry. It places **real paper orders** — the
only gates are `AGENT_ENABLED`, `COMPETITION_ENFORCE`, `RISK_ENFORCE`.

- **Dashboard**: the Agent tab has a *Run cycle* button and an *Auto-run* toggle
  (60 s `setInterval` while the tab is open) — for local monitoring only.
  - **Official run (Vercel)**: `.github/workflows/agent-cron.yml` — GitHub Actions
  posts `POST /api/agent/run` every **2 minutes** Mon–Thu 13:00–20:59 UTC. Set
  repository secrets `AGENT_RUN_URL` and `MCP_AUTH_TOKEN`. Do **not** use Vercel
  Hobby cron for this (max once per day). See §5 for Blob persistence.
- **Official run (always-on box)**: `scripts/agent-runner.mjs` (`pnpm agent:run`) — a 60 s loop
  that POSTs the endpoint for the whole scoring window, then stops after the
  snapshot. Backs off on a run of errors. Run it on any always-on box:

  ```
  AGENT_RUN_URL=https://<host>/api/agent/run \
  MCP_AUTH_TOKEN=<token> \
  pm2 start scripts/agent-runner.mjs --name alpaca-agent
  # or: nohup node scripts/agent-runner.mjs > agent-runner.log 2>&1 &
  # or systemd — see below
  ```

  Env: `AGENT_RUN_URL` (default `http://localhost:3000/api/agent/run`),
  `MCP_AUTH_TOKEN`, `AGENT_RUNNER_MS` (default 60000, min 15000),
  `AGENT_RUNNER_UNTIL` (default `2026-09-03T20:05:00Z`).

  Plain crontab alternative (coarser, minute granularity, no back-off):

  ```
  * 13-20 * * 1-4  curl -fsS -XPOST -H "Authorization: Bearer $MCP_AUTH_TOKEN" https://<host>/api/agent/run > /dev/null
  ```

  The endpoint self-gates (scoring window, one entry per ET day, `AGENT_ENABLED`),
  so calling it every minute for the full window is safe — most calls just run
  the manage pass. When `MCP_AUTH_TOKEN` is set the route requires that bearer.
  The route also holds a process-wide lock: if a cycle is still running when the
  next call lands, the later call returns `phase: "skipped"` immediately rather
  than starting a second overlapping manage/entry pass. Run **one** driver — two
  runners against the same server just trade skips.

  <details><summary>systemd unit</summary>

  ```ini
  [Unit]
  Description=Alpaca LLM trading agent runner
  After=network-online.target

  [Service]
  WorkingDirectory=/opt/alpaca-hackathon-trading-agent
  Environment=AGENT_RUN_URL=http://localhost:3000/api/agent/run
  Environment=MCP_AUTH_TOKEN=…
  ExecStart=/usr/bin/node scripts/agent-runner.mjs
  Restart=on-failure

  [Install]
  WantedBy=multi-user.target
  ```
  </details>

---

## 3. Configuration

**`src/config/agent.ts`** — all calibration (thresholds, sizing, timings). Pure
constants: edit and redeploy. **`src/config/env.ts`** — only the LLM endpoint:

| var | default | note |
| --- | --- | --- |
| `AGENT_LLM_BASE_URL` | `http://localhost:11434/v1` | OpenAI-compatible `chat/completions` base |
| `AGENT_LLM_MODEL` | `qwen3:8b` | set to what you pulled, e.g. `qwen3:30b` |
| `AGENT_LLM_API_KEY` | — | omit for a local Ollama |
| `AGENT_LLM_MAX_TOKENS` | `4096` | **completion budget — see the warning below** |
| `AGENT_LLM_TIMEOUT_MS` | `120000` | qwen3:14b takes ~45s warm on the entry prompt |
| `AGENT_ENABLED` | `true` | `false` → `/api/agent/run` returns 503 |
| `AGENT_STORAGE` | `filesystem` | `blob` on Vercel (needs `BLOB_READ_WRITE_TOKEN`) |
| `BLOB_READ_WRITE_TOKEN` | — | auto-injected when a Blob store is linked |

> **Reasoning models need a large `AGENT_LLM_MAX_TOKENS`.** qwen3, deepseek-r1
> and friends spend completion tokens *thinking* before they write the answer,
> and Ollama returns that thinking in a separate `reasoning` field rather than in
> `content`. Set the budget too low and the whole allowance goes to the thought:
> the reply comes back `finish_reason: "length"` with **`content: ""`**, the
> client raises `LlmUnavailableError`, and the fail-safe matrix below turns that
> into `act=false` — a silent veto of **every** entry, for the whole run. The
> answer itself is ~150 tokens; the rest of the budget is headroom for the
> thinking. The client also strips inline `<think>…</think>` for hosts that
> return it that way, and names this cause explicitly in the error when
> `finish_reason` is `length`.

**Featherless** (production on Vercel) — instruct model, no code change:

```
AGENT_LLM_BASE_URL=https://api.featherless.ai/v1
AGENT_LLM_API_KEY=<key>
AGENT_LLM_MODEL=Qwen/Qwen2.5-14B-Instruct
AGENT_LLM_MAX_TOKENS=1024
AGENT_LLM_TIMEOUT_MS=60000
AGENT_STORAGE=blob
```

Local Ollama (reasoning model) — keep a large completion budget:

```
AGENT_LLM_BASE_URL=http://localhost:11434/v1
AGENT_LLM_MODEL=qwen3:14b
AGENT_LLM_MAX_TOKENS=4096
```

---

## 4. Fail-safe matrix (LLM)

| situation | entry | manage |
| --- | --- | --- |
| endpoint unreachable / DNS / refused | **skip** (`act=false`) | **hold** |
| timeout (`AGENT_LLM_TIMEOUT_MS`) | skip | hold |
| HTTP 4xx / 5xx | skip | hold |
| reply not JSON / fails schema after 1 retry | skip | hold |
| `AGENT.llmDailyCallCap` exhausted | skip | hold |
| manage says `close` but the close order throws | — | spread stays open, retried next cycle; **3× stop still armed** |
| close order accepted but never fills | — | after 90s the order is cancelled and the spread is re-closed **at market** (`CLOSE_ORDER_TIMEOUT_MS`) |
| `AGENT_ENABLED=false` | route 503 | route 503 |
| kill switch tripped (`isHalted`) | `executeSignal` risk gate blocks (under `RISK_ENFORCE`) | mechanical closes still attempted (closing skips the gate) |

Invariant: the stop, target, time-close and deadline never call the LLM and
never depend on it.

---

## 5. State & audit

- `agent/agent-state.json` (Vercel Blob) or `${AGENT_LOG_DIR}/agent-state.json`
  (local) — mutable working memory: what the agent holds, whether it entered
  today, running notes. Rewritten when state changes.
- `agent/decisions.jsonl` or `${AGENT_LOG_DIR}/decisions.jsonl` — the [O5]
  append-only audit trail: why each decision was made, alternatives rejected,
  guardrail verdicts, and the `llm` field — model + tokens + latency **plus the
  exact user prompt the model saw and the raw text it replied with**
  (`llm.prompt` / `llm.response`), so a reviewer can reconstruct *why* the
  model decided what it did. The system prompt is a code constant
  (`ENTRY_SYSTEM_PROMPT` / `MANAGE_SYSTEM_PROMPT`) and is not duplicated per
  record. `GET /api/agent/decisions?format=review` renders the trail for a
  reviewing model.

  It is not only the agent that writes here. `executeSignal` logs every
  execution that is **not** the agent (the `place_option_strategy` MCP tool, any
  manual strategy signal); every raw order / close / cancel path — MCP
  `place_order`, `close_position`, `close_all_positions`, `replace_order`,
  `cancel_order`, `cancel_all_orders`, and their REST equivalents — logs via
  `recordManualAction` (`strategy: "manual:<mcp|rest>"`). So one file answers
  "every order the system placed, by whom, and why".

Both are under `.agent/` locally (gitignored). **Vercel deploy:**

1. Vercel → Storage → Blob → Connect to project (`BLOB_READ_WRITE_TOKEN` is set
   automatically).
2. Set `AGENT_STORAGE=blob` in project env.
3. **Before the first cron run**, upload existing local state:
   `BLOB_READ_WRITE_TOKEN=… pnpm agent:upload-state` (reads `.agent/`).
4. If state is lost without a backup, `hydrateAgentStateFromAlpaca()` rebuilds
   open spreads from Alpaca positions (credit from avg entry prices) so mechanical
   exits keep working — but LLM notes and the decisions history are only recovered
   from Blob / the local JSONL.

Do **not** add a `crons` entry in `vercel.json` with sub-daily frequency on the
Hobby plan — deployment will fail. Use `.github/workflows/agent-cron.yml` or an
external scheduler instead.

**Local dev:** `.agent/` on disk (`AGENT_STORAGE=filesystem`, default). The
in-memory ring is per-process; `readRecentDecisionsFromDisk` backfills the API
after a cold start.

---

## 6. The net-credit order sign

Alpaca `mleg` limit orders: **positive `limit_price` = net debit, negative = net
credit** (Alpaca docs + support; the vendored SDK passes negatives through
untouched). `signalToOrder` sends `-entryLimit` for a credit-spread *open* and
`+entryLimit` for the *close*.

Before the official run, confirm it live: **`pnpm agent:verify-mleg`** (needs
`pnpm dev` running) places one tiny far-OTM 1-contract SPY put credit spread at a
−0.05 limit, prints what Alpaca returned, and cancels it. If it fails, set
`AGENT.creditEntryOrderType = "market"` in `src/config/agent.ts` — entries then
go out as market mleg orders in the 10:00–11:00 ET window and the sign is moot
(`entryLimit` is still computed for the risk gate).

## 7. Known divergences from the backtest

- **Stop is 3× credit**, not the backtest default of 2× — a deliberate override
  (docs/07 §7.2: a level stop that is tighter fires earlier on noise).
- **`pickExpiration`** takes the DTE closest to the window midpoint; the backtest
  takes the first in-window expiration. ≤ 1 calendar day of divergence at
  `minDte 1 / maxDte 2`, both inside the judged window.
- **Bars via REST** (`getHistoricalBars`), not the market hub — a cron request
  must not create a hub subscription side-effect. Only daily *underlying* closes
  (for realised vol), never delayed option bars.

---

## 8. Not built

An SSE surface for decisions (a 30 s poll is enough); a backtest of the
veto/early-close layer itself.
