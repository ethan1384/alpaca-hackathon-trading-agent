import { z } from "zod";

/**
 * Backtest contract for the short-credit-spread strategy on SPY
 * (`docs/strategie-credit-spreads-spy.md`): 1–2 DTE defined-risk premium
 * selling, posted as an iron condor decomposed into two independent vertical
 * credit spreads that are sized, watched and closed separately.
 *
 * Same two-layer split as the ORB backtest (`backtest.ts`) — a signal layer and
 * a structure layer — but the signal here is trivial (enter every day at a
 * fixed time), so essentially all of the result comes from the structure. That
 * inverts where the scepticism has to go: for the ORB the question was "does
 * the trigger work?", here it is "is the premium being modelled honestly?".
 *
 * Three inputs decide the answer, and none of them can be *discovered* from
 * underlying bars — they are assumptions the operator makes:
 *
 * - `ivMultiplier` is the variance risk premium, i.e. the strategy's entire
 *   edge. It defaults to 1.0 (IV = realised vol, no premium at all), because a
 *   backtest that grants a premium seller a generous IV has assumed its own
 *   conclusion. Raise it deliberately, and read the result as conditional on it.
 * - `ivShockPerDownPct` makes IV rise as the underlying falls. Its effect is
 *   not the obvious one: the stop is a *level* on the credit, so it does not
 *   make the average loss bigger — it makes the stop fire sooner, on a smaller
 *   move. Modelled flat, the underlying has to travel further before the spread
 *   reaches `stopMultiple`, and the strategy is credited with survival it would
 *   not have had. This is also why the stop level itself is the parameter the
 *   result is most sensitive to — see `stopMultiple`.
 * - `stopSlippagePct` is what the stop actually costs beyond its trigger level.
 */

/** `"HH:MM"` in US/Eastern. */
const etTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM in US/Eastern");

// --- Parameters ------------------------------------------------------------

export const CreditBacktestParamsSchema = z.object({
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
  /** See `BacktestParamsSchema.feed` — SIP by default for the same reason. */
  feed: z.enum(["iex", "sip"]).default("sip"),

  initialEquity: z.number().positive().default(100_000),

  // --- Entry ---
  /** One decision window per session, after the opening auction has settled. */
  entryTimeEt: etTime.default("10:00"),
  /** Expiry search window, calendar days. The nearest expiry inside it is taken. */
  minDte: z.number().int().min(0).max(10).default(1),
  maxDte: z.number().int().min(0).max(10).default(3),
  /** |delta| of the short leg. The spec's band is 0.15–0.20. */
  targetDelta: z.number().gt(0).lt(0.5).default(0.175),
  spreadWidth: z.number().positive().default(5),
  strikeStep: z.number().positive().default(1),
  /** Per side, after entry friction. Acts as an implicit IV floor. */
  minCredit: z.number().min(0).default(0.25),
  /** `both` is the condor; `put` is the reduced variant that keeps theta and drops neutrality. */
  sides: z.enum(["both", "put", "call"]).default("both"),

  // --- Sizing and the risk gate ---
  riskPerSidePct: z.number().gt(0).max(0.1).default(0.01),
  maxConcurrentSpreads: z.number().int().min(1).max(20).default(4),
  /** Hard dollar ceiling on defined-risk margin held at once. */
  buyingPowerCap: z.number().positive().default(12_000),
  /** …and a ceiling relative to equity, whichever binds first. */
  buyingPowerPctCap: z.number().gt(0).max(1).default(0.4),
  /** Cumulative risk opened in one session, as a fraction of equity. */
  dailyRiskCapPct: z.number().gt(0).max(1).default(0.04),
  /**
   * Cap on |net book delta| × spot, as a fraction of equity.
   *
   * Evaluated on the proposed structure as a whole before any leg is committed:
   * the two sides of a condor are individually directional and only neutral
   * together. A condor authorization never carries over to a reduced single
   * spread — the gate is re-run on the lone side's delta.
   */
  maxNetDeltaPctEquity: z.number().gt(0).max(5).default(0.25),
  /** Mark-to-market drawdown from the session's opening equity that flattens the book. */
  dailyDrawdownStopPct: z.number().gt(0).max(1).default(0.05),

  // --- Exits ---
  /** Buy back once the spread has decayed to this fraction of the credit. */
  targetProfitPct: z.number().gt(0).max(1).default(0.5),
  /**
   * Stop when the buy-back cost reaches this multiple of the credit.
   *
   * Defaults to 3, not the 2 the spec originally carried. A stop is a level on
   * the *credit*, but the risk it is protecting is the *width*: at a 0.57
   * credit on a 5-wide spread, a 2x stop cuts at 16% of defined risk, which on
   * a 1-2 DTE short vertical sits inside ordinary intraday gamma noise. It
   * fires on a quarter of all trades and most of them would have reverted.
   * 3x cuts at ~29% of defined risk and fires on ~12%. See
   * `docs/07-strategie-credit-spreads.md` §7.7 for the sweep.
   */
  stopMultiple: z.number().gt(1).default(3),
  /** Mandatory close on expiry day. Assignment risk is not a modelled outcome. */
  closeAtEt: etTime.default("15:30"),

  // --- Volatility model ---
  hvLookbackDays: z.number().int().min(5).max(120).default(20),
  /**
   * IV as a multiple of prior realised vol — the variance risk premium.
   * Defaults to 1.0: no premium granted. This is the strategy's edge, and a
   * backtest cannot observe it from underlying bars.
   */
  ivMultiplier: z.number().gt(0).default(1),
  /**
   * Relative IV increase per 1% the underlying sits below its entry price.
   *
   * Applied on down moves only — IV falling on a rally would help both short
   * sides, and that is the half of the effect worth not being paid for. Set it
   * to 0 to see how much of the strategy's survival came from a flat vol
   * surface; the stops move measurably later.
   */
  ivShockPerDownPct: z.number().min(0).max(1).default(0.15),
  /** Extra IV on the put side, standing in for index skew. */
  putIvPremium: z.number().min(0).max(1).default(0.1),
  riskFreeRate: z.number().min(0).max(0.2).default(0.04),

  // --- Friction ---
  /** Dollars given up per leg per crossing. Reduces the credit, raises the buy-back. */
  frictionPerLeg: z.number().min(0).default(0.015),
  /** Extra cost of a stop, as a fraction of the credit, above its trigger level. */
  stopSlippagePct: z.number().min(0).max(2).default(0.25),
});

export type CreditBacktestParams = z.infer<typeof CreditBacktestParamsSchema>;
export type CreditBacktestParamsInput = z.input<typeof CreditBacktestParamsSchema>;

// --- Results ---------------------------------------------------------------

export const CREDIT_EXIT_REASONS = [
  "target",
  "stop",
  "time_close",
  "expiry",
  "kill_switch",
  "coverage_end",
] as const;
export type CreditExitReason = (typeof CREDIT_EXIT_REASONS)[number];

export interface CreditExit {
  timestamp: string;
  spot: number;
  /** Cost paid per share to buy the spread back, including exit friction. */
  cost: number;
  reason: CreditExitReason;
}

export type SpreadSide = "put" | "call";

export interface CreditTrade {
  id: string;
  underlying: string;
  /** Entry session date, `YYYY-MM-DD` (US/Eastern). */
  date: string;
  side: SpreadSide;

  entryTimestamp: string;
  entrySpot: number;
  expiration: string;
  /** Calendar days from entry session to expiration. */
  dte: number;

  shortStrike: number;
  longStrike: number;
  width: number;
  /** Annualised IV used to price both legs at entry. */
  iv: number;
  /** |delta| of the short leg at entry — what the 0.175 target actually resolved to. */
  shortDelta: number;

  /** Net credit received per share, after entry friction. */
  credit: number;
  /** `width - credit`, per share. */
  maxLoss: number;
  contracts: number;
  /** Capital at risk: `maxLoss * 100 * contracts`. */
  riskAmount: number;

  exit: CreditExit;
  pnl: number;
  rMultiple: number;
  equityAfter: number;
  /** Minutes the position was open. */
  minutesHeld: number;

  /** Cheapest and dearest buy-back seen while open. */
  minCost: number;
  maxCost: number;
}

export interface EquityPoint {
  timestamp: string;
  equity: number;
}

export interface CreditBacktestStats {
  trades: number;
  wins: number;
  losses: number;
  hitRate: number;
  avgWin: number;
  avgLoss: number;
  payoffRatio: number;
  /**
   * The hit rate this payoff ratio needs to break even. For premium selling
   * this is the whole story: a high win rate is structural, not evidence.
   */
  breakEvenHitRate: number;
  expectancy: number;
  totalPnl: number;
  finalEquity: number;
  returnPct: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  /** Mean credit and max loss per share, across all trades. */
  avgCredit: number;
  avgMaxLoss: number;
  avgMinutesHeld: number;
  bySide: Record<string, { trades: number; pnl: number; hitRate: number }>;
  byUnderlying: Record<string, { trades: number; pnl: number; hitRate: number }>;
  byExitReason: Record<string, number>;
}

/** A gate refusal with enough detail to distinguish a legitimate block from a bug. */
export interface CreditGateRejection {
  timestamp: string;
  underlying: string;
  date: string;
  structure: "condor" | "put" | "call";
  control: string;
  observed: string;
  threshold: string;
  sides: SpreadSide[];
}

export interface CreditBacktestResult {
  params: CreditBacktestParams;
  trades: CreditTrade[];
  equityCurve: EquityPoint[];
  stats: CreditBacktestStats;
  sessionsScanned: number;
  /** Sessions where at least one side was actually opened. */
  sessionsWithEntry: number;
  /** Why a side was refused, and how often — keeps "no trade" from reading as "no signal". */
  rejections: Record<string, number>;
  /** Gate refusals with control, observed value, threshold, and proposed structure. */
  rejectionLog: CreditGateRejection[];
  warnings: string[];
}
