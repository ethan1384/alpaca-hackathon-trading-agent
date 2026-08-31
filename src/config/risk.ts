/**
 * Machine-readable restatement of the risk & operational parameters. Prose +
 * rationale live in `docs/06-options-parameters.md`; the ids below ([K#]/[O#])
 * point back at it.
 *
 * Pure module — no env, no `server-only`, no I/O — so the server gate, the MCP
 * status tool and any UI surface can import it, and so every rule is
 * unit-testable. Anything that needs an account, a chain or a clock lives in
 * `src/server/risk/`.
 *
 * Design rule, applied throughout: **an unavailable input is `null`, never a
 * default.** A cap that silently passes because a greek was missing is worse
 * than no cap — it reports safety it never checked.
 */

import type { MarketClock, OptionQuoteRow } from "@/domain/types";

/** A regular US equity session is 09:30–16:00 ET. */
const REGULAR_SESSION_MINUTES = 390;
const MINUTE_MS = 60_000;

export const RISK = {
  // --- Portfolio caps [K1]-[K6] -------------------------------------------
  /**
   * [K1] Net directional exposure, as dollar-delta over equity.
   *
   * The source document expresses this in "SPY-share equivalents", which needs
   * beta-weighting we cannot compute reliably here. The computable equivalent
   * is signed dollar-delta — `Σ delta × 100 × contracts × spot` — capped as a
   * fraction of equity. `netDeltaSpyShares` reports the SPY-share number
   * alongside it, for legibility only; the cap is enforced on the fraction.
   */
  maxNetDeltaNotionalPct: 0.6,
  /** [K2] Net vega, in $ of P&L per 1 IV point, as a fraction of equity. */
  maxNetVegaPctOfEquity: 0.004,
  /** [K3] Fraction of equity that may sit in used buying power. */
  maxBuyingPowerPct: 0.35,
  /** [K4] Max loss a single position may carry, as a fraction of equity. */
  maxLossPerPositionPct: 0.02,
  /** [K5] Correlation cap — max simultaneous positions sharing one sector. */
  maxPositionsPerSector: 2,
  /** [K6] Max simultaneous open positions. */
  maxConcurrentPositions: 6,

  // --- Operational [O1]-[O3] ----------------------------------------------
  /** [O1] Intraday drawdown from the session's opening equity that trips the kill switch. */
  killSwitchDrawdownPct: 0.08,
  /** [O3] No order in the first N minutes of the session — spreads are widest at the open. */
  openBlackoutMinutes: 10,
  /** [O3] No order in the last N minutes of the session. */
  closeBlackoutMinutes: 10,
  /** [O2] An implied volatility above this is a bad tick, not a market. 500%. */
  maxPlausibleIv: 5,
  /** [O2] A quote older than this is stale; do not price off it. */
  maxQuoteAgeMs: 5 * MINUTE_MS,
  /** [O2] A relative spread this wide means the book is not really there. */
  maxPlausibleSpreadPct: 0.5,
  /** [O4] Consecutive submission failures before the agent alerts and stops retrying. */
  maxConsecutiveRejects: 3,
  /** [O4] Base delay for the retry backoff, in ms. Doubles each attempt. */
  retryBaseDelayMs: 500,
} as const;

/**
 * Sector map for the correlation cap [K5]. Deliberately coarse: the point is
 * that twenty US mega-cap tech spreads are one macro position, not twenty
 * trades. Broad-market ETFs get their own bucket — they *are* the macro.
 *
 * An underlying absent from this map is treated as its own sector (no grouping),
 * which is the permissive reading; extend the map rather than relying on that.
 */
export const SECTORS: Record<string, string> = {
  SPY: "broad-market",
  QQQ: "broad-market",
  IWM: "broad-market",
  DIA: "broad-market",
  AAPL: "mega-tech",
  MSFT: "mega-tech",
  NVDA: "mega-tech",
  GOOGL: "mega-tech",
  GOOG: "mega-tech",
  AMZN: "mega-tech",
  META: "mega-tech",
  AVGO: "mega-tech",
  AMD: "mega-tech",
  TSLA: "consumer-cyclical",
  NFLX: "consumer-cyclical",
  JPM: "financials",
  BAC: "financials",
  GS: "financials",
  XOM: "energy",
  CVX: "energy",
  UNH: "healthcare",
  LLY: "healthcare",
  JNJ: "healthcare",
};

export function sectorOf(underlying: string): string {
  return SECTORS[underlying.toUpperCase()] ?? `unmapped:${underlying.toUpperCase()}`;
}

// --- Exposure model --------------------------------------------------------

/** One open option position, reduced to what the risk caps actually need. */
export interface PositionExposure {
  /** OCC symbol. */
  symbol: string;
  underlying: string;
  /** Signed contract count: positive long, negative short. */
  contracts: number;
  /** Current market value of the position, in $. */
  marketValue: number;
  /**
   * Capital genuinely at risk on this line, in $. For long premium this is what
   * was paid; for a defined-risk spread it is width × 100 − credit. `null` when
   * the caller could not establish it — which is itself a [K4] violation, since
   * an unquantified risk cannot be shown to be under the cap.
   */
  riskAmount: number | null;
  /** Per-contract delta from the chain. `null` when the greek was unavailable. */
  delta: number | null;
  /**
   * Per-contract vega from the chain, in $ per IV point. Alpaca reports vega per
   * **1 vol point (0.01 of IV)**, not per 1.00 — verified against Black-Scholes
   * on the live 2026-08-31 SPY chain: the 762 put quoted 0.1004 where
   * `S·φ(d1)·√T` gives 10.05 per 1.00. So `vega × 100 × contracts` is already
   * dollars per vol point, which is what `maxNetVegaPctOfEquity` caps.
   */
  vega: number | null;
  /** Underlying spot, needed to turn delta into dollar-delta. */
  spot: number | null;
}

/** Aggregate risk state of the account at one instant. */
export interface PortfolioExposure {
  equity: number;
  /** Fraction of equity currently committed as buying power. */
  buyingPowerUsedPct: number;
  positionCount: number;
  /** Σ delta × 100 × contracts × spot, in $. `null` if any position lacked a greek. */
  netDeltaNotional: number | null;
  /** [K1] reported in SPY shares, for human legibility. `null` without a SPY spot. */
  netDeltaSpyShares: number | null;
  /** Σ vega × 100 × contracts, in $ per IV point. `null` if any position lacked a greek. */
  netVegaUsd: number | null;
  /** Open position count per sector [K5]. */
  positionsPerSector: Record<string, number>;
  /** Positions whose risk amount could not be established. */
  unpricedPositions: string[];
}

/**
 * Fold positions into a `PortfolioExposure`.
 *
 * Missing greeks propagate to `null` rather than contributing 0: a net delta
 * computed from half the book is not a net delta.
 */
export function aggregateExposure(
  positions: PositionExposure[],
  account: { equity: number; buyingPower: number },
  spySpot?: number,
): PortfolioExposure {
  let netDeltaNotional: number | null = 0;
  let netVegaUsd: number | null = 0;
  const positionsPerSector: Record<string, number> = {};
  const unpricedPositions: string[] = [];

  for (const p of positions) {
    if (netDeltaNotional !== null) {
      netDeltaNotional =
        p.delta == null || p.spot == null
          ? null
          : netDeltaNotional + p.delta * 100 * p.contracts * p.spot;
    }
    if (netVegaUsd !== null) {
      netVegaUsd = p.vega == null ? null : netVegaUsd + p.vega * 100 * p.contracts;
    }
    if (p.riskAmount == null) {
      unpricedPositions.push(p.symbol);
    }
    const sector = sectorOf(p.underlying);
    positionsPerSector[sector] = (positionsPerSector[sector] ?? 0) + 1;
  }

  const committed = Math.max(0, account.equity - account.buyingPower);

  return {
    equity: account.equity,
    buyingPowerUsedPct: account.equity > 0 ? committed / account.equity : 0,
    positionCount: positions.length,
    netDeltaNotional,
    netDeltaSpyShares:
      netDeltaNotional != null && spySpot != null && spySpot > 0
        ? Math.round(netDeltaNotional / spySpot)
        : null,
    netVegaUsd,
    positionsPerSector,
    unpricedPositions,
  };
}

// --- Verdicts --------------------------------------------------------------

export interface RiskVerdict {
  allowed: boolean;
  violations: string[];
  warnings: string[];
}

const OK: RiskVerdict = { allowed: true, violations: [], warnings: [] };

function verdict(violations: string[], warnings: string[] = []): RiskVerdict {
  return { allowed: violations.length === 0, violations, warnings };
}

/** A prospective new position, for pre-trade checking. */
export interface CandidatePosition {
  underlying: string;
  /** Capital at risk if the trade goes fully against us, in $. */
  riskAmount: number | null;
  /** Dollar-delta the trade would add. `null` when greeks were unavailable. */
  deltaNotional: number | null;
  /** Vega the trade would add, in $ per IV point. */
  vegaUsd: number | null;
}

/**
 * [K1]-[K6] evaluated against the book as it would stand *after* `candidate`.
 * Pass no candidate to audit the current book on its own.
 */
export function checkPortfolioRisk(
  exposure: PortfolioExposure,
  candidate?: CandidatePosition,
): RiskVerdict {
  const violations: string[] = [];
  const warnings: string[] = [];
  const { equity } = exposure;

  if (equity <= 0) {
    return verdict([`account equity is ${equity} — no sizing decision is meaningful`]);
  }

  // [K3] Buying power. Checked on the book as it stands; the candidate's own
  // consumption is bounded by [K4] below.
  if (exposure.buyingPowerUsedPct > RISK.maxBuyingPowerPct) {
    violations.push(
      `[K3] buying power used ${(exposure.buyingPowerUsedPct * 100).toFixed(1)}% > ${(RISK.maxBuyingPowerPct * 100).toFixed(0)}% cap`,
    );
  }

  // [K4] Per-position loss cap.
  const maxLoss = equity * RISK.maxLossPerPositionPct;
  if (candidate) {
    if (candidate.riskAmount == null) {
      violations.push(
        "[K4] candidate's capital at risk could not be established — an unquantified risk cannot be shown to be under the cap",
      );
    } else if (candidate.riskAmount > maxLoss) {
      violations.push(
        `[K4] candidate risks $${candidate.riskAmount.toFixed(0)} > $${maxLoss.toFixed(0)} (${(RISK.maxLossPerPositionPct * 100).toFixed(0)}% of equity)`,
      );
    }
  }
  for (const symbol of exposure.unpricedPositions) {
    warnings.push(`[K4] open position ${symbol} has no established risk amount`);
  }

  // [K6] Position count.
  const projectedCount = exposure.positionCount + (candidate ? 1 : 0);
  if (projectedCount > RISK.maxConcurrentPositions) {
    violations.push(`[K6] ${projectedCount} open positions > ${RISK.maxConcurrentPositions} cap`);
  }

  // [K5] Correlation. Twenty spreads on one sector are one position.
  const perSector = { ...exposure.positionsPerSector };
  if (candidate) {
    const sector = sectorOf(candidate.underlying);
    perSector[sector] = (perSector[sector] ?? 0) + 1;
  }
  for (const [sector, count] of Object.entries(perSector)) {
    if (count > RISK.maxPositionsPerSector) {
      violations.push(
        `[K5] ${count} positions in sector "${sector}" > ${RISK.maxPositionsPerSector} cap — that is one macro position, not ${count} trades`,
      );
    }
  }

  // [K1] Net dollar-delta.
  const deltaCap = equity * RISK.maxNetDeltaNotionalPct;
  if (exposure.netDeltaNotional == null) {
    warnings.push("[K1] net delta unavailable (a position is missing greeks) — cap not checked");
  } else {
    const projected = exposure.netDeltaNotional + (candidate?.deltaNotional ?? 0);
    if (candidate && candidate.deltaNotional == null) {
      warnings.push("[K1] candidate's delta unavailable — projected net delta excludes it");
    }
    if (Math.abs(projected) > deltaCap) {
      violations.push(
        `[K1] net dollar-delta $${projected.toFixed(0)} exceeds ±$${deltaCap.toFixed(0)} (${(RISK.maxNetDeltaNotionalPct * 100).toFixed(0)}% of equity)`,
      );
    }
  }

  // [K2] Net vega.
  const vegaCap = equity * RISK.maxNetVegaPctOfEquity;
  if (exposure.netVegaUsd == null) {
    warnings.push("[K2] net vega unavailable (a position is missing greeks) — cap not checked");
  } else {
    const projected = exposure.netVegaUsd + (candidate?.vegaUsd ?? 0);
    if (Math.abs(projected) > vegaCap) {
      violations.push(
        `[K2] net vega $${projected.toFixed(0)}/IV point exceeds ±$${vegaCap.toFixed(0)}`,
      );
    }
  }

  return verdict(violations, warnings);
}

// --- [O1] Kill switch ------------------------------------------------------

export interface DrawdownReading {
  /** Equity at the start of the session, per the account's `lastEquity`. */
  sessionOpenEquity: number;
  equity: number;
  /** Positive = down on the day. */
  drawdownPct: number;
  tripped: boolean;
}

/**
 * [O1] Intraday drawdown against the session's opening equity. `lastEquity` is
 * Alpaca's previous-close equity, which is the session-open reference.
 */
export function readDrawdown(account: { equity: number; lastEquity?: number }): DrawdownReading {
  const sessionOpenEquity = account.lastEquity ?? account.equity;
  const drawdownPct =
    sessionOpenEquity > 0 ? (sessionOpenEquity - account.equity) / sessionOpenEquity : 0;
  return {
    sessionOpenEquity,
    equity: account.equity,
    drawdownPct,
    tripped: drawdownPct > RISK.killSwitchDrawdownPct,
  };
}

// --- [O2] Data circuit breaker ---------------------------------------------

/**
 * [O2] Is this chain row a real quote? A bad tick that reaches sizing is worse
 * than no tick: it prices a trade off a number the market never showed.
 * Returns the reasons the row is untrustworthy; empty means sane.
 */
export function quoteAnomalies(row: OptionQuoteRow, now: Date = new Date()): string[] {
  const reasons: string[] = [];

  if (row.bid == null || row.ask == null) {
    reasons.push("no two-sided quote");
  } else {
    if (row.bid <= 0) {
      reasons.push(`bid is ${row.bid} — no bid means no exit`);
    }
    if (row.ask <= row.bid) {
      reasons.push(`crossed or locked book (bid ${row.bid} >= ask ${row.ask})`);
    }
    const mid = (row.bid + row.ask) / 2;
    if (mid > 0 && (row.ask - row.bid) / mid > RISK.maxPlausibleSpreadPct) {
      reasons.push(
        `spread ${(((row.ask - row.bid) / mid) * 100).toFixed(0)}% of mid exceeds the plausible ceiling`,
      );
    }
  }

  if (row.impliedVolatility != null && row.impliedVolatility > RISK.maxPlausibleIv) {
    reasons.push(`implied volatility ${(row.impliedVolatility * 100).toFixed(0)}% is not a market`);
  }

  if (row.updatedAt) {
    const age = now.getTime() - Date.parse(row.updatedAt);
    if (Number.isFinite(age) && age > RISK.maxQuoteAgeMs) {
      reasons.push(`quote is ${Math.round(age / MINUTE_MS)}min stale`);
    }
  }

  return reasons;
}

/** [O2] Freeze entries when any row backing a decision is untrustworthy. */
export function checkChainSanity(rows: OptionQuoteRow[], now: Date = new Date()): RiskVerdict {
  const violations: string[] = [];
  for (const row of rows) {
    const reasons = quoteAnomalies(row, now);
    if (reasons.length > 0) {
      violations.push(`[O2] ${row.symbol}: ${reasons.join("; ")}`);
    }
  }
  return verdict(violations);
}

// --- [O3] Execution time window --------------------------------------------

/**
 * [O3] No order in the first or last 10 minutes of the session — that is when
 * spreads are widest and the fill is worst.
 *
 * `MarketClock` gives `nextClose` but not the session's open, so the open is
 * derived as `nextClose − 390min` (the regular session length). Pass
 * `sessionOpen` explicitly when a real value is available.
 */
export function checkExecutionWindow(
  clock: MarketClock,
  now: Date = new Date(),
  sessionOpen?: Date,
): RiskVerdict {
  if (!clock.isOpen) {
    return verdict(["[O3] market is closed"]);
  }

  const close = Date.parse(clock.nextClose);
  if (!Number.isFinite(close)) {
    return { ...OK, warnings: ["[O3] clock has no usable nextClose — window not checked"] };
  }
  const open = sessionOpen?.getTime() ?? close - REGULAR_SESSION_MINUTES * MINUTE_MS;
  const t = now.getTime();

  const sinceOpen = (t - open) / MINUTE_MS;
  const untilClose = (close - t) / MINUTE_MS;

  if (sinceOpen < RISK.openBlackoutMinutes) {
    return verdict([
      `[O3] ${sinceOpen.toFixed(1)}min into the session — the first ${RISK.openBlackoutMinutes}min are blacked out (widened spreads)`,
    ]);
  }
  if (untilClose < RISK.closeBlackoutMinutes) {
    return verdict([
      `[O3] ${untilClose.toFixed(1)}min to the close — the last ${RISK.closeBlackoutMinutes}min are blacked out (widened spreads)`,
    ]);
  }
  return OK;
}

/** Merge several verdicts into one. */
export function mergeVerdicts(...verdicts: RiskVerdict[]): RiskVerdict {
  return verdict(
    verdicts.flatMap((v) => v.violations),
    verdicts.flatMap((v) => v.warnings),
  );
}
