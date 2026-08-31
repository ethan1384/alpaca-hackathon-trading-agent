import { NextResponse } from "next/server";
import { getEnv } from "@/config/env";
import { runAgentCycle } from "@/server/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Fluid Compute on Vercel Hobby allows up to 300s — room for slow LLM + Alpaca. */
export const maxDuration = 300;

/**
 * Process-wide guard against overlapping cycles. Two `agent-runner.mjs`
 * processes (or a cron plus a manual poke) pointed at the same server used to
 * run the manage pass — and its ~45s dead-zone LLM calls — twice over, and race
 * on the entry path: on 2026-08-31 both builds passed the `entryInFlightAt`
 * check (only set *after* the LLM returns) and both hit `executeSignal`, the
 * second saved from a double position only by the deterministic client order id.
 * One cycle at a time per process; a caller that overlaps gets a cheap skip.
 */
let cycleInFlight: Promise<unknown> | null = null;

/**
 * Runs ONE agent cycle: manage every open spread, then (inside the daily entry
 * window) build a candidate and put it to the LLM for a veto. This places real
 * paper orders — it is only ever gated by `AGENT_ENABLED`, `COMPETITION_ENFORCE`
 * and `RISK_ENFORCE`. The official run drives this from an external cron; see
 * `docs/08-agent.md`.
 */
export async function POST(request: Request) {
  const env = getEnv();

  if (!env.AGENT_ENABLED) {
    return NextResponse.json({ error: "agent is disabled (AGENT_ENABLED=false)" }, { status: 503 });
  }

  if (env.MCP_AUTH_TOKEN) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${env.MCP_AUTH_TOKEN}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  }

  // DEV ONLY: run the cycle against a simulated clock so the entry path can be
  // exercised before the scoring window opens. Ignored under COMPETITION_ENFORCE
  // so it can never touch the official run.
  const now =
    env.AGENT_CLOCK_OVERRIDE && !env.COMPETITION_ENFORCE
      ? new Date(env.AGENT_CLOCK_OVERRIDE)
      : undefined;

  if (cycleInFlight) {
    return NextResponse.json(
      {
        at: new Date().toISOString(),
        phase: "skipped",
        skipped: "another cycle is already running",
        entry: { evaluated: false, reason: "another cycle is already running" },
        managed: [],
        errors: [],
      },
      { status: 200 },
    );
  }

  const cycle = runAgentCycle(now ? { now } : undefined);
  cycleInFlight = cycle;
  try {
    return NextResponse.json(await cycle);
  } catch (error) {
    const message = error instanceof Error ? error.message : "agent cycle failed";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    cycleInFlight = null;
  }
}
