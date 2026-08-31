/**
 * Machine-readable calibration for the LLM decision agent. Prose lives in
 * `docs/08-agent.md`; the strategy rationale in `docs/07-strategie-credit-spreads.md`.
 *
 * Pure module — no env, no `server-only`, no I/O — so the agent core, the API
 * routes, the MCP tools and the UI can all import it, and every threshold is
 * unit-testable. Secrets and endpoints live in `src/config/env.ts`; account
 * risk caps ([K#]/[O#]) live in `src/config/risk.ts` and still run at
 * `executeSignal()`.
 *
 * The LLM only ever adds an **entry veto** and an **early close in the dead
 * zone**. The profit target, the stop, the time-close and the pre-snapshot
 * forced close are mechanical checks keyed off these numbers — the model is
 * never consulted on them.
 */

export const AGENT = {
  /** Tag written to every `StrategySignal.strategy` and decision-log record. */
  strategy: "agent:credit-spread",
  underlying: "SPY",
  /** Put credit spread — sell the higher-strike put, buy the lower-strike put. */
  kind: "bull_put_spread",
  bias: "bullish",

  // --- Entry -------------------------------------------------------------
  /** One entry decision per ET session, inside this window (after the open vol settles). */
  entryWindowEt: { start: "10:00", end: "11:00" },
  /** DTE window for the short leg. 1-2 keeps every leg inside the judged snapshot. */
  minDte: 1,
  maxDte: 2,
  /** Absolute delta of the short leg (spec band 0.15-0.20). */
  targetDelta: 0.175,
  /** Long/short strike distance in points. */
  spreadWidth: 5,
  /**
   * Liquidity floor for a resolvable leg.
   *
   * Open interest is a *cumulative* measure, so on a daily-expiry SPY contract —
   * which has existed for days, not months — it stays low however tight the book
   * actually is. A floor of 500 (a monthlies number) punched holes straight
   * through the wing band: on 2026-08-28's 1-DTE chain it rejected the 757 put
   * (OI 490, bid/ask 0.19/0.21 — a 10% relative spread) while admitting the 762
   * the strategy was selling (OI 615, 0.105). Refusing to *buy* protection that
   * is quoted more tightly than the leg being sold is backwards, and it dropped
   * the wing to 759: a 3-wide spread paying 0.21, which `minCredit` then vetoed.
   * No trade, every day.
   *
   * `maxSpreadPct` below is the direct liquidity evidence and does the real work;
   * this floor only screens out contracts nobody holds at all.
   */
  minOpenInterest: 250,
  /** Reject a leg whose bid/ask spread exceeds this fraction of its mark. */
  maxSpreadPct: 0.2,
  /** Implicit IV floor: reject the entry if the credit (after cushion) is below this. */
  minCredit: 0.25,
  /** credit/width sanity ceiling — above this the modelled chain is implausible. */
  maxCreditRatio: 0.6,
  /**
   * credit/width **floor**, checked on the post-cushion credit actually collected.
   *
   * Below this the spread does not pay enough to survive its own stop. docs/07 §7
   * backtests this strategy at ~0.114 average credit/width (0.57 on a 5-wide) for
   * an 83% break-even rate at the ×3 stop; a spread paying materially less is
   * structurally negative-EV. The 2026-08-31 live entry — $68 credit against $932
   * of risk, ratio 0.068 — is exactly the trade this rejects. Tune against
   * docs/06 / docs/07, not the day's quote.
   */
  minCreditRatio: 0.1,
  /** Reject if the *resolved* short leg's |delta| exceeds this (too close to the money). */
  shortDeltaMax: 0.28,

  // --- Exits (mechanical — the LLM cannot touch these) -----------------
  /** Buy back at 50% of the credit collected. */
  targetProfitPct: 0.5,
  /** Stop: buy back once the spread costs this multiple of the credit. */
  stopMultiple: 3,
  /** Time-close on the expiry session at this ET time... */
  timeCloseEt: "15:30",
  /** ...or this many minutes to expiry, whichever comes first. */
  timeCloseMinutes: 30,
  /** Force every position flat this many minutes before the 20:00Z equity snapshot. */
  forceCloseMinutesBeforeSnapshot: 45,

  // --- Dead zone (the only place the manage LLM is consulted) ----------
  /** Spot within this fraction of the short strike counts as "near". */
  deadZoneProximityPct: 0.01,
  /** ...or fewer than this many minutes to expiry. */
  deadZoneMinutes: 120,

  // --- Sizing ---------------------------------------------------------
  /** Max loss per spread as a fraction of account equity. */
  riskPerSidePct: 0.01,
  /** Never hold more than this many agent spreads at once. */
  maxConcurrentSpreads: 2,

  // --- Order pricing ------------------------------------------------
  /**
   * Entry order type. `"limit"` sends a net-credit mleg limit (Alpaca:
   * negative = credit) at `midCredit − limitCushion`. `"market"` sends a market
   * mleg in the tight 10:00–11:00 ET window instead — the safe fallback if a
   * live preview ever shows the negative limit rejected (see
   * `scripts/verify-mleg-sign.mjs`). `entryLimit` is still computed either way so
   * the risk gate can price the position.
   */
  creditEntryOrderType: "limit" as "limit" | "market",
  /** Ask this much less credit than mid, to fill (entry). */
  limitCushion: 0.02,
  /** Pay this much over mid to buy back (close). */
  closeLimitCushion: 0.03,

  // --- Operational --------------------------------------------------
  /** Hard cap on LLM calls per ET session — a runaway loop cannot bankrupt the key. */
  llmDailyCallCap: 60,
  llmTemperature: 0.2,
} as const;

export type AgentConfig = typeof AGENT;

/** `"HH:MM"` (24h, ET) -> minutes since ET midnight. Throws on a malformed string. */
export function etMinutes(hhmm: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) {
    throw new Error(`etMinutes: expected "HH:MM", got ${JSON.stringify(hhmm)}`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new Error(`etMinutes: ${hhmm} is not a valid time`);
  }
  return hours * 60 + minutes;
}

/** Minutes since ET midnight for a `Date`, using the America/New_York wall clock. */
export function etMinutesOf(now: Date): number {
  const parts = ET_TIME_FORMAT.formatToParts(now);
  const rawHours = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const hours = rawHours === 24 ? 0 : rawHours; // some ICU builds render midnight as "24"
  const minutes = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hours * 60 + minutes;
}

const ET_TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
