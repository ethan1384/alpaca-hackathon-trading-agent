import { z } from "zod";

/**
 * Backtest contract for the ORB → 0DTE debit-vertical strategy.
 *
 * Two layers, deliberately kept separate (see `src/server/backtest/`):
 *
 * 1. **Signal** — does the opening-range breakout reach one range extension
 *    before it falls back into the range? Computed on the underlying's 1-minute
 *    bars alone. This is the only question that can invalidate the strategy.
 * 2. **Structure** — what the vertical would have paid, repriced with
 *    Black-Scholes along that same path.
 *
 * Layer 2 uses a model rather than historical option bars on purpose. Option
 * bars are *trade* prints with no bid/ask, so a backtest built on them produces
 * clean fills and flatters exactly the assumption that matters most here — that
 * a 0DTE stop recovers almost nothing. `frictionPerLeg` and `stopRecoveryPct`
 * make that pessimism an explicit, movable parameter instead of a hidden one.
 */

// --- Parameters ------------------------------------------------------------

/** `"HH:MM"` in US/Eastern. */
const etTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM in US/Eastern");

export const BacktestParamsSchema = z.object({
  underlyings: z
    .array(
      z
        .string()
        .min(1)
        .transform((s) => s.toUpperCase()),
    )
    .min(1)
    .default(["SPY"]),
  /** Inclusive session range, `YYYY-MM-DD`. */
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),

  /**
   * Market-data feed for the underlying's bars.
   *
   * This is not a detail: IEX prints roughly 4% of consolidated volume, so an
   * opening range and a volume-confirmation trigger computed on it are drawn
   * from a different tape than the one the strategy would actually trade.
   * Defaults to `sip` here rather than to `ALPACA_DATA_FEED`, because a
   * backtest run on the thin feed answers a question nobody asked.
   */
  feed: z.enum(["iex", "sip"]).default("sip"),

  initialEquity: z.number().positive().default(100_000),
  /** Fraction of equity risked per trade. Risk = the full debit — see `stopRecoveryPct`. */
  riskPerTradePct: z.number().gt(0).max(0.1).default(0.01),

  // --- Signal (layer 1) ---
  /** Length of the opening range, in minutes from the 09:30 ET open. */
  openingRangeMinutes: z.number().int().min(5).max(60).default(15),
  /** Breakout must clear the range edge by this fraction of spot. */
  breakoutBufferPct: z.number().min(0).max(0.01).default(0.0005),
  /** Trigger bar volume must exceed this multiple of the opening range's mean. */
  volumeMultiple: z.number().min(0).default(1.5),
  /** Only take longs above session VWAP, shorts below. */
  requireVwapAlign: z.boolean().default(true),
  /** Only take longs above the prior session's close, shorts below. */
  requirePriorCloseAlign: z.boolean().default(true),
  maxTradesPerDay: z.number().int().min(1).max(5).default(2),
  /**
   * Whether a second entry may follow a trade that reached its target.
   *
   * Off by default, and the default matters: once price is extended, every
   * later high-volume bar is still "beyond the range", so an unrestricted
   * re-entry rule buys the top of the move it just captured. A re-entry is
   * only allowed after a stop, where the thesis may still be intact.
   */
  allowReentryAfterTarget: z.boolean().default(false),

  // --- Structure (layer 2) ---
  targetDelta: z.number().gt(0).lt(1).default(0.45),
  /**
   * `fixed` uses `fixedWidth`; `range` sets the width to one opening range.
   *
   * Fixed is the calibrated default: a 0.45-delta long leg three points wide.
   * Note what `range` mode buys that this gives up — with the width equal to
   * one opening range, the target lands on the short strike by construction,
   * so "one range extension" and "spread at max value" are the same price. On
   * a fixed width the target is a flat dollar distance instead.
   */
  widthMode: z.enum(["range", "fixed"]).default("fixed"),
  fixedWidth: z.number().positive().default(3),
  strikeStep: z.number().positive().default(1),

  // --- Volatility model ---
  /** Sessions of realised vol used to seed IV. No lookahead: strictly prior sessions. */
  hvLookbackDays: z.number().int().min(5).max(120).default(20),
  /** 0DTE IV trades above realised vol; this is the premium, as a multiple. */
  ivMultiplier: z.number().gt(0).default(1.15),
  riskFreeRate: z.number().min(0).max(0.2).default(0.04),

  // --- Friction (the knobs that decide the answer) ---
  /** Dollars given up per leg per crossing. Paid on entry and again on exit. */
  frictionPerLeg: z.number().min(0).default(0.015),
  /** Fraction of the debit recovered when the structural stop fires. */
  stopRecoveryPct: z.number().min(0).max(1).default(0.15),
  /**
   * How far past the range edge the stop sits, as a fraction of the range.
   *
   * Entry happens on a close *above* the edge, so a stop exactly at the edge is
   * only a few ticks away and fires on ordinary noise around the breakout. This
   * pushes it back into the range by a share of the range's own size.
   */
  stopBufferPct: z.number().min(0).max(1).default(0),

  // --- Exits ---
  /** Fraction of the position taken off at `scaleOutAtMaxProfitPct`. */
  scaleOutFraction: z.number().min(0).max(1).default(0.5),
  scaleOutAtMaxProfitPct: z.number().gt(0).max(1).default(0.6),

  // --- Flatten ladder (US/Eastern) ---
  noNewEntriesAfter: etTime.default("14:00"),
  closeLosersAt: etTime.default("14:45"),
  halveAt: etTime.default("15:15"),
  closeAllAt: etTime.default("15:30"),
  marketSweepAt: etTime.default("15:45"),
});

export type BacktestParams = z.infer<typeof BacktestParamsSchema>;
/** Shape accepted on the wire, before defaults are applied. */
export type BacktestParamsInput = z.input<typeof BacktestParamsSchema>;

// --- Results ---------------------------------------------------------------

export const EXIT_REASONS = [
  "target",
  "scale_out",
  "stop",
  "flatten_loser",
  "flatten_halve",
  "flatten_all",
  "market_sweep",
  "expiry",
] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];

/** One partial or full exit. `fraction` is the share of the original size closed. */
export interface BacktestExit {
  timestamp: string;
  spot: number;
  fraction: number;
  /** Net value received per spread, after exit friction. */
  value: number;
  reason: ExitReason;
}

export interface BacktestTrade {
  id: string;
  underlying: string;
  /** Session date, `YYYY-MM-DD` (US/Eastern). */
  date: string;
  direction: "long" | "short";
  kind: "bull_call_spread" | "bear_put_spread";

  entryTimestamp: string;
  entrySpot: number;
  rangeHigh: number;
  rangeLow: number;
  rangeSize: number;

  longStrike: number;
  shortStrike: number;
  width: number;
  /** Annualised IV used to price both legs. */
  iv: number;

  /** Net debit per spread, including entry friction. */
  entryDebit: number;
  contracts: number;
  /** Capital genuinely at risk: the full debit. Matches [K4]'s `riskAmount`. */
  riskAmount: number;

  exits: BacktestExit[];
  /** Size-weighted mean exit value per spread. */
  avgExitValue: number;
  pnl: number;
  /** P&L as a fraction of `riskAmount` (an R multiple). */
  rMultiple: number;
  equityAfter: number;

  /** Best and worst spread value seen while the position was open. */
  maxFavorable: number;
  maxAdverse: number;
}

export interface EquityPoint {
  timestamp: string;
  equity: number;
}

export interface BacktestStats {
  trades: number;
  wins: number;
  losses: number;
  hitRate: number;
  avgWin: number;
  avgLoss: number;
  /** avgWin / avgLoss. Below 1 means the losers are bigger than the winners. */
  payoffRatio: number;
  /** The hit rate this payoff ratio needs to break even. The number to beat. */
  breakEvenHitRate: number;
  /** Mean P&L per trade, in dollars. */
  expectancy: number;
  totalPnl: number;
  finalEquity: number;
  returnPct: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  /** Share of triggers that reached one full range extension. */
  targetReachedRate: number;
  byUnderlying: Record<string, { trades: number; pnl: number; hitRate: number }>;
  byExitReason: Record<string, number>;
}

export interface BacktestResult {
  params: BacktestParams;
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  stats: BacktestStats;
  /** Sessions that produced no trigger, and why — keeps the sample size honest. */
  sessionsScanned: number;
  sessionsWithTrigger: number;
  warnings: string[];
}
