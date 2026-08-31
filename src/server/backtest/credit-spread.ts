import "server-only";

import type { CreditBacktestParams, CreditBacktestResult } from "@/domain/backtest-credit";
import { type CreditBacktestDeps, runCreditSpreadEngine } from "./credit-spread-engine";
import { processEntryAggregate } from "./credit-spread-entry";

export type { CreditBacktestDeps } from "./credit-spread-engine";
export { summariseCredit } from "./credit-spread-stats";

/**
 * Engine for the short-credit-spread strategy (`docs/07-strategie-credit-spreads.md`).
 *
 * Entry uses an aggregate risk gate: both sides of a condor are built in memory,
 * evaluated as one structure, and committed all-or-nothing. See
 * `runCreditBacktestLegacy` for the pre-fix per-leg gate.
 */
export async function runCreditBacktest(
  params: CreditBacktestParams,
  deps: Partial<CreditBacktestDeps> = {},
): Promise<CreditBacktestResult> {
  return runCreditSpreadEngine(params, processEntryAggregate, deps);
}
