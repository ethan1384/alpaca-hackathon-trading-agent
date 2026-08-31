import "server-only";

import { getEnv } from "@/config/env";
import {
  checkChainSanity,
  checkExecutionWindow,
  checkPortfolioRisk,
  mergeVerdicts,
  type RiskVerdict,
} from "@/config/risk";
import type { OptionOrderLeg, StrategySignal } from "@/domain/strategy";
import type { MarketClock } from "@/domain/types";
import { getOptionSnapshots as defaultGetOptionSnapshots } from "@/server/alpaca/options";
import { getMarketClock as defaultGetMarketClock } from "@/server/alpaca/rest";
import { buildPortfolioExposure, type ExposureDeps, priceCandidate } from "./exposure";
import { isHalted } from "./kill-switch";

/**
 * The single pre-trade risk gate.
 *
 * `assertSignalAllowed` (`../strategies/guardrails.ts`) answers "does the
 * *hackathon* allow this trade?". This answers the separate question "does the
 * *account* survive it?" — [K1]-[K6] and [O1]-[O3] from
 * `docs/06-options-parameters.md`. Both run before every opening order, from
 * `executeSignal`, which is the only execution entry point.
 *
 * The two are kept apart on purpose. Competition rules are fixed by the
 * organisers and expire with the event; risk caps are ours and outlive it.
 * Collapsing them would make it impossible to relax one without relaxing the
 * other.
 */

export interface RiskGateDeps extends Partial<ExposureDeps> {
  getMarketClock?: () => Promise<MarketClock>;
}

/**
 * `RISK_ENFORCE` decides whether a breach throws or merely warns — the same
 * escape hatch as `COMPETITION_ENFORCE`, for the same reason: a guardrail must
 * never be why an unrelated call fails (a unit test with no credentials, a
 * backtest against the test feed). **The official run sets it to `true`.**
 */
export function isRiskEnforced(): boolean {
  try {
    return getEnv().RISK_ENFORCE;
  } catch {
    return false;
  }
}

export interface RiskGateResult extends RiskVerdict {
  /** Every sub-check, kept separate so the decision log records what actually ran. */
  checks: Record<string, RiskVerdict>;
  /** False when enforcement is off and nothing was evaluated. */
  evaluated: boolean;
}

/**
 * Evaluate the risk layer for an opening trade. Pure reporting — throws
 * nothing, so callers (MCP, UI, the decision log) can surface the verdict
 * without side effects.
 */
export async function checkTrade(
  signal: StrategySignal,
  legs: OptionOrderLeg[],
  deps: RiskGateDeps = {},
  now: Date = new Date(),
): Promise<RiskGateResult> {
  const checks: Record<string, RiskVerdict> = {};

  // [O1] Halted means halted. Checked first and without I/O: once the kill
  // switch has tripped there is nothing to look up.
  if (isHalted()) {
    const verdict: RiskVerdict = {
      allowed: false,
      violations: ["[O1] kill switch is tripped — the agent is halted until manually re-armed"],
      warnings: [],
    };
    return { ...verdict, checks: { killSwitch: verdict }, evaluated: true };
  }
  checks.killSwitch = { allowed: true, violations: [], warnings: [] };

  const getMarketClock = deps.getMarketClock ?? defaultGetMarketClock;
  const getOptionSnapshots = deps.getOptionSnapshots ?? defaultGetOptionSnapshots;

  // [O3] Execution window.
  checks.executionWindow = await getMarketClock().then(
    (clock) => checkExecutionWindow(clock, now),
    (error) => ({
      allowed: true,
      violations: [],
      warnings: [`[O3] clock unavailable (${String(error)}) — window not checked`],
    }),
  );

  // [O2] Data circuit breaker on the contracts we are about to trade.
  checks.dataIntegrity = await getOptionSnapshots(legs.map((l) => l.symbol)).then(
    (snapshots) => {
      const rows = legs.map((l) => snapshots.get(l.symbol)).filter((r) => r != null);
      const missing = legs.length - rows.length;
      const verdict = checkChainSanity(rows, now);
      return missing > 0
        ? {
            ...verdict,
            allowed: false,
            violations: [
              ...verdict.violations,
              `[O2] ${missing} of ${legs.length} legs returned no snapshot — cannot price a trade off contracts the feed will not quote`,
            ],
          }
        : verdict;
    },
    (error) => ({
      allowed: false,
      violations: [`[O2] option snapshots unavailable (${String(error)}) — entries frozen`],
      warnings: [],
    }),
  );

  // [K1]-[K6] Portfolio caps, evaluated against the book as it would stand
  // after this trade.
  try {
    const [exposure, candidate] = await Promise.all([
      buildPortfolioExposure(deps),
      priceCandidate(signal, legs, deps),
    ]);
    checks.portfolio = checkPortfolioRisk(exposure, candidate);
  } catch (error) {
    checks.portfolio = {
      allowed: false,
      violations: [
        `[K] portfolio exposure could not be built (${String(error)}) — refusing to size against an unknown book`,
      ],
      warnings: [],
    };
  }

  const merged = mergeVerdicts(...Object.values(checks));
  return { ...merged, checks, evaluated: true };
}

/**
 * Throw if the risk layer refuses the trade and enforcement is on; otherwise log
 * the warnings and let it through. Called by `executeSignal` before submission.
 */
export async function assertTradeAllowed(
  signal: StrategySignal,
  legs: OptionOrderLeg[],
  deps: RiskGateDeps = {},
  now: Date = new Date(),
): Promise<RiskGateResult> {
  if (!isRiskEnforced()) {
    return {
      allowed: true,
      violations: [],
      warnings: ["RISK_ENFORCE is off — portfolio and operational risk checks were not run"],
      checks: {},
      evaluated: false,
    };
  }

  const result = await checkTrade(signal, legs, deps, now);
  for (const warning of result.warnings) {
    console.warn(`[risk] ${warning}`);
  }
  if (!result.allowed) {
    throw new Error(`Risk gate: ${result.violations.join("; ")}`);
  }
  return result;
}
