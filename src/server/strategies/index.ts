import "server-only";

import type { StrategySignal } from "@/domain/strategy";
import type { TradingPosition } from "@/domain/trading";
import type { Bar, MarketClock, Quote } from "@/domain/types";

/**
 * Everything a strategy sees on one evaluation. Built from the hub
 * (`MarketHub.getBars()`), the trading API (position), and the clock.
 */
export interface StrategyContext {
  /** Underlying being evaluated (never an option symbol). */
  underlying: string;
  bars: Bar[];
  quote?: Quote;
  /** Current option position for this thesis, if any. */
  position?: TradingPosition;
  clock: MarketClock;
}

/**
 * A trading strategy. `evaluate` returns a `StrategySignal` (options-only, see
 * `src/domain/strategy.ts`) or `null` for "do nothing". Signals are turned into
 * contracts by `resolveContracts` and submitted by `executeSignal`.
 */
export interface Strategy {
  readonly name: string;
  evaluate(ctx: StrategyContext): Promise<StrategySignal | null>;
}

export { type ExecuteSignalDeps, executeSignal, signalToOrder } from "./execute";
export {
  applyCompetitionDteWindow,
  assertSignalAllowed,
  checkSignal,
  type GuardrailVerdict,
  isCompetitionEnforced,
  isOpeningSignal,
} from "./guardrails";
export { resolveContracts, type SelectContractDeps } from "./select-contract";
