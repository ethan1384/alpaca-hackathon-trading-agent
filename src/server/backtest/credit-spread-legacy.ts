import "server-only";

import type { CreditBacktestParams, CreditBacktestResult } from "@/domain/backtest-credit";
import { type CreditBacktestDeps, runCreditSpreadEngine } from "./credit-spread-engine";
import { processEntryPerLeg } from "./credit-spread-entry";

/**
 * Pre-fix backtest runner — evaluates the risk gate per leg as each side is
 * added to the book. Kept for A/B comparison against the aggregate gate in
 * `runCreditBacktest`. See `docs/07-strategie-credit-spreads.md` §7.5.
 */
export async function runCreditBacktestLegacy(
  params: CreditBacktestParams,
  deps: Partial<CreditBacktestDeps> = {},
): Promise<CreditBacktestResult> {
  return runCreditSpreadEngine(params, processEntryPerLeg, deps);
}
