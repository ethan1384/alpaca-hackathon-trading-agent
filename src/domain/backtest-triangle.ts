import { z } from "zod";
import type { EquityPoint } from "./backtest";

/**
 * Backtest contract for the ascending-triangle breakout → long call structure,
 * swing-traded on daily bars (`docs/09-strategie-triangle.md`).
 *
 * Same two-layer split as the ORB backtest (`backtest.ts`):
 *
 * 1. **Signal** — a flat resistance touched several times, a rising floor of
 *    higher lows, then the first close through the lid on above-average
 *    volume. Computed on the underlying's daily bars alone
 *    (`src/server/backtest/triangle.ts`). Whether the breakout carries on to its
 *    measured-move target is the question that can invalidate the strategy.
 * 2. **Structure** — a bull call spread (or a naked long call) repriced with
 *    Black-Scholes along that same path. IV is realised vol times
 *    `ivMultiplier`, an assumption rather than something the bars can reveal.
 *
 * Unlike the two intraday engines, positions here live for days or weeks and
 * overlap across underlyings, so the engine simulates a portfolio day by day
 * and marks it to model every close.
 */

export const TRIANGLE_DEFAULT_UNIVERSE = [
  "SPY",
  "QQQ",
  "IWM",
  "AAPL",
  "MSFT",
  "NVDA",
  "AMZN",
  "META",
  "GOOGL",
  "AMD",
] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ticker = z
  .string()
  .min(1)
  .transform((s) => s.toUpperCase());

// --- Parameters ------------------------------------------------------------

export const TriangleBacktestParamsSchema = z.object({
  underlyings: z
    .array(ticker)
    .min(1)
    .max(40)
    .default([...TRIANGLE_DEFAULT_UNIVERSE]),
  /** Inclusive session range, `YYYY-MM-DD`. Daily history before `start` is fetched to seed patterns and vol. */
  start: isoDate,
  end: isoDate,
  /** See `BacktestParamsSchema.feed` — the volume filter wants the consolidated tape. */
  feed: z.enum(["iex", "sip"]).default("sip"),
  /** Buy-and-hold comparison drawn under the equity curve. */
  benchmark: ticker.default("SPY"),

  initialEquity: z.number().positive().default(100_000),
  /** Fraction of equity risked per trade. Risk = the full debit: a long premium position can lose all of it. */
  riskPerTradePct: z.number().gt(0).max(0.1).default(0.01),
  /** Positions open at once across the book. One per underlying on top of this. */
  maxOpenPositions: z.number().int().min(1).max(20).default(5),

  // --- Signal (layer 1) ---
  /** Bars each side a swing high/low must dominate. Also the confirmation delay: a pivot is known `pivotStrength` bars late. */
  pivotStrength: z.number().int().min(1).max(10).default(3),
  /** How far back a pattern may reach, in bars. */
  lookbackBars: z.number().int().min(15).max(250).default(60),
  /** Minimum bars from the first touch of the resistance to the breakout. */
  minPatternBars: z.number().int().min(5).max(200).default(15),
  /** Swing highs that must sit on the resistance. Three is the textbook "triple top" lid. */
  minTouches: z.number().int().min(2).max(6).default(3),
  /** A swing high within this fraction below the resistance counts as a touch. */
  touchTolerancePct: z.number().min(0).max(0.05).default(0.01),
  /**
   * Swing lows the rising floor needs: the lowest bar between each pair of
   * consecutive touches, plus the final squeeze before the breakout — each
   * strictly higher than the one before.
   */
  minLowPivots: z.number().int().min(2).max(6).default(2),
  /** Floor regression slope, as a fraction of price per bar. Keeps a flat range from passing as a triangle. */
  minSlopePctPerBar: z.number().min(0).max(0.01).default(0.0005),
  /** Resistance minus the lowest floor low, as a fraction of the resistance. */
  minHeightPct: z.number().min(0).max(0.5).default(0.03),
  /** The close must clear the resistance by this fraction. */
  breakoutBufferPct: z.number().min(0).max(0.05).default(0.002),
  /** Breakout-day volume must exceed this multiple of the prior `volumeLookbackBars` mean. */
  volumeMultiple: z.number().min(0).default(1.2),
  volumeLookbackBars: z.number().int().min(5).max(60).default(20),
  /** Bars after a breakout during which the same underlying cannot fire again. */
  cooldownBars: z.number().int().min(0).max(60).default(10),

  // --- Structure (layer 2) ---
  structure: z.enum(["bull_call_spread", "long_call"]).default("bull_call_spread"),
  /** Delta of the long call. */
  targetDelta: z.number().gt(0).lt(1).default(0.45),
  /**
   * Where the short call of the spread goes.
   *
   * `measured` puts it on the measured-move target (resistance + height),
   * rounded up to the strike grid — the target and the spread's maximum value
   * then sit at the same price, as the ORB's `range` width does. `pct` puts it a
   * flat `shortStrikePct` above spot instead.
   */
  shortStrikeMode: z.enum(["measured", "pct"]).default("measured"),
  shortStrikePct: z.number().gt(0).max(0.5).default(0.05),
  /** Calendar days to the target expiry; the first Friday on or after entry + this is taken. */
  dteDays: z.number().int().min(7).max(120).default(35),
  /** Strike grid. Omit for an automatic step of roughly 0.5% of spot. */
  strikeStep: z.number().positive().optional(),

  // --- Volatility model ---
  /** Sessions of realised vol used to seed IV. Strictly prior closes only. */
  hvLookbackDays: z.number().int().min(5).max(120).default(20),
  /** IV as a multiple of realised vol. An assumption — see docs/09 §5. */
  ivMultiplier: z.number().gt(0).default(1.1),
  riskFreeRate: z.number().min(0).max(0.2).default(0.04),

  // --- Friction ---
  /**
   * Given up per leg per crossing, as a fraction of that leg's model price.
   * Relative rather than a flat dollar amount because the universe spans
   * underlyings from ~$30 to ~$900. Paid on entry and again on exit.
   */
  frictionPct: z.number().min(0).max(0.2).default(0.03),
  /** Floor on the per-leg friction, in dollars — a one-cent tick is never free. */
  minFrictionPerLeg: z.number().min(0).default(0.01),

  // --- Exits (all keyed off the underlying, checked at the daily close) ---
  /**
   * `resistance`: the breakout failed once price closes back under the old lid
   * by `stopBufferPct`. `support`: only a close under the rising floor, extended
   * forward, by `stopBufferPct`. The first is tighter.
   */
  stopMode: z.enum(["resistance", "support"]).default("resistance"),
  stopBufferPct: z.number().min(0).max(0.2).default(0.02),
  /** Spread only: take profit once its value reaches this share of the maximum profit. 1 disables it. */
  takeProfitPctOfMax: z.number().gt(0).max(1).default(0.8),
  /** Sessions held before the time stop, counting the entry session. */
  maxHoldDays: z.number().int().min(1).max(90).default(15),
  /** Close once the expiry is this many calendar days away, before gamma and theta take over. */
  exitDteFloor: z.number().int().min(0).max(30).default(7),
});

export type TriangleBacktestParams = z.infer<typeof TriangleBacktestParamsSchema>;
/** Shape accepted on the wire, before defaults are applied. */
export type TriangleBacktestParamsInput = z.input<typeof TriangleBacktestParamsSchema>;

// --- Results ---------------------------------------------------------------

export const TRIANGLE_EXIT_REASONS = [
  "stop",
  "target",
  "take_profit",
  "time_stop",
  "dte_floor",
  "end_of_data",
] as const;
export type TriangleExitReason = (typeof TRIANGLE_EXIT_REASONS)[number];

export interface PricePoint {
  timestamp: string;
  price: number;
}

/** Everything needed to redraw the pattern on a chart. */
export interface TriangleGeometry {
  /** First touch of the resistance — where the pattern begins. */
  startTimestamp: string;
  resistance: number;
  touches: PricePoint[];
  /** The rising floor's swing lows. */
  lows: PricePoint[];
  /** Regression line through `lows`, from the first low to the breakout bar. */
  support: { from: PricePoint; to: PricePoint };
  /** Resistance minus the lowest floor low. */
  height: number;
  /** Measured-move objective: resistance + height. */
  target: number;
  breakoutTimestamp: string;
  breakoutClose: number;
  /** Breakout-day volume over the trailing mean. */
  volumeRatio: number;
}

export interface TriangleTrade {
  id: string;
  underlying: string;
  structure: "bull_call_spread" | "long_call";
  triangle: TriangleGeometry;

  /** Session date of the entry, the bar after the breakout. */
  entryDate: string;
  entryTimestamp: string;
  /** The entry bar's open. */
  entrySpot: number;
  expiration: string;
  /** Calendar days from entry to expiry. */
  dteAtEntry: number;

  longStrike: number;
  /** Null for a naked long call. */
  shortStrike: number | null;
  width: number | null;
  iv: number;
  /** Debit per contract-share, including entry friction. */
  entryDebit: number;
  contracts: number;
  /** The full debit: what the position can lose. */
  riskAmount: number;
  /** Stop level on the underlying at entry (moves with the floor in `support` mode). */
  stopLevel: number;

  exitDate: string;
  exitTimestamp: string;
  exitSpot: number;
  /** Net value received per contract-share, after exit friction. */
  exitValue: number;
  exitReason: TriangleExitReason;
  /** Sessions held, counting the entry session. */
  holdingDays: number;
  /** Whether the underlying's high reached the measured-move target while the position was open. */
  targetReached: boolean;

  pnl: number;
  /** P&L over `riskAmount`. */
  rMultiple: number;
  equityAfter: number;
  /** Best and worst model value of the structure at a close while open. */
  maxFavorable: number;
  maxAdverse: number;
}

/** Where the breakouts went — keeps the sample size honest. */
export interface TriangleFunnel {
  /** Breakouts that passed every signal filter, volume included. */
  breakouts: number;
  /** Patterns whose breakout close came on thin volume. */
  rejectedVolume: number;
  /** No entry bar inside the window, or not enough history for realised vol. */
  skippedData: number;
  /** Book full, or the underlying already held. */
  skippedCapacity: number;
  /** Gapped past the target, or a debit outside the plausible band. */
  skippedStructure: number;
  /** One contract would risk more than `riskPerTradePct`. */
  skippedSizing: number;
  taken: number;
}

export interface TriangleStats {
  trades: number;
  wins: number;
  losses: number;
  hitRate: number;
  avgWin: number;
  avgLoss: number;
  payoffRatio: number;
  /** `1 / (1 + payoff)` — the hit rate this payoff needs to break even. */
  breakEvenHitRate: number;
  expectancy: number;
  avgR: number;
  totalPnl: number;
  finalEquity: number;
  returnPct: number;
  /** Compound annual growth over the calendar span of the curve. Null under a day. */
  cagr: number | null;
  /** Annualised, from daily mark-to-model returns, zero rate. Null when flat. */
  sharpe: number | null;
  maxDrawdown: number;
  /** Peak-relative: the deepest fall from a running high, as a fraction of that high. */
  maxDrawdownPct: number;
  avgHoldingDays: number;
  /** Share of trades whose underlying reached the measured move before the exit. */
  targetReachedRate: number;
  benchmarkReturnPct: number | null;
  benchmarkMaxDrawdownPct: number | null;
  byUnderlying: Record<string, { trades: number; pnl: number; hitRate: number }>;
  byExitReason: Record<string, number>;
}

/** `[unix seconds, open, high, low, close, volume]` — compact for the wire. */
export type CompactBar = [number, number, number, number, number, number];

export interface TriangleBacktestResult {
  params: TriangleBacktestParams;
  trades: TriangleTrade[];
  /** One point per session, marked to model at the close. */
  equityCurve: EquityPoint[];
  /** Buy-and-hold `params.benchmark`, scaled to `initialEquity`. Empty when unavailable. */
  benchmarkCurve: EquityPoint[];
  stats: TriangleStats;
  funnel: TriangleFunnel;
  /** Daily bars of every underlying that traded, for the pattern charts. */
  barsByUnderlying: Record<string, CompactBar[]>;
  sessionsScanned: number;
  warnings: string[];
}
