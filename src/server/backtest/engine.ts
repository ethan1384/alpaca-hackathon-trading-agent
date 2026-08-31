import "server-only";

import type {
  BacktestExit,
  BacktestParams,
  BacktestResult,
  BacktestStats,
  BacktestTrade,
  EquityPoint,
  ExitReason,
} from "@/domain/backtest";
import type { Bar } from "@/domain/types";
import { getBarsRange as defaultGetBarsRange } from "@/server/alpaca/rest";
import {
  type OptionType,
  optionPrice,
  realisedVolatility,
  strikeForDelta,
  tradingYears,
  verticalValue,
} from "./black-scholes";
import {
  detectTriggers,
  groupSessions,
  MARKET_CLOSE_ET,
  openingRange,
  parseEtTime,
  type Session,
  type SessionBar,
  type Trigger,
} from "./orb";

/**
 * Joins the signal layer (`orb.ts`) to the structure layer (`black-scholes.ts`)
 * and walks each session minute by minute.
 *
 * Two modelling choices carry most of the result, and both are deliberately
 * pessimistic because the alternative flatters the strategy:
 *
 * - **`stopRecoveryPct`** caps what a structural stop returns. On a 0DTE
 *   vertical the spread is usually near-worthless by the time the underlying
 *   has travelled back through the range, so the average loss sits close to the
 *   maximum loss. Sizing is computed on the full debit for the same reason.
 * - **Within-bar ordering** checks the stop before the target. A 1-minute bar
 *   does not say which extreme came first, so the losing one is assumed to.
 *
 * Time to expiry is counted in *trading* minutes (`tradingYears`), on the same
 * 252-session calendar realised vol is annualised on. This was calendar time
 * until it was measured: a 6.5-hour session is 1/252 of a trading year but only
 * 1/1348 of a calendar one, so `t` came out ~5x too small, sigma*sqrt(t) ~2.3x
 * too small, and the vertical was priced far too cheap. Correcting it moves the
 * strategy's whole result — see `docs/07-strategie-credit-spreads.md` §6.
 */

export interface BacktestDeps {
  getBarsRange: (
    symbol: string,
    timeframe: "1Min" | "1Day",
    start: string,
    end: string,
    maxPerSymbol?: number,
    feed?: "iex" | "sip",
  ) => Promise<Bar[]>;
}

/** Sizing refuses a structure this far outside a genuine 0.45-delta vertical. */
const MIN_DEBIT_RATIO = 0.1;
const MAX_DEBIT_RATIO = 0.9;
/** Calendar days of daily history pulled before `start` to seed realised vol. */
const HV_HISTORY_PAD_DAYS = 200;
/**
 * Per-symbol bar cap. Extended-hours minute bars run ~960 a session, so this
 * covers roughly a year. The engine still checks what came back against what it
 * asked for — a silently truncated fetch produces a plausible equity curve for
 * a window that was never tested, which is worse than an error.
 */
const MAX_BARS_PER_SYMBOL = 400_000;

/** The flatten ladder, parsed once into ET minutes-from-midnight. */
interface Ladder {
  noNewEntries: number;
  closeLosers: number;
  halve: number;
  closeAll: number;
  sweep: number;
}

interface OpenPosition {
  underlying: string;
  date: string;
  direction: "long" | "short";
  type: OptionType;
  entryTimestamp: string;
  entrySpot: number;
  rangeHigh: number;
  rangeLow: number;
  rangeSize: number;
  longStrike: number;
  shortStrike: number;
  width: number;
  iv: number;
  entryDebit: number;
  contracts: number;
  riskAmount: number;
  remaining: number;
  exits: BacktestExit[];
  maxFavorable: number;
  maxAdverse: number;
  scaledOut: boolean;
}

function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Annualised IV for a session: realised vol over prior sessions only, marked up. */
function impliedVolFor(
  dailyCloses: { date: string; close: number }[],
  sessionDate: string,
  lookback: number,
  multiplier: number,
): number | null {
  const prior = dailyCloses.filter((d) => d.date < sessionDate).slice(-lookback - 1);
  const hv = realisedVolatility(prior.map((d) => d.close));
  return hv == null || hv <= 0 ? null : hv * multiplier;
}

export async function runBacktest(
  params: BacktestParams,
  deps: Partial<BacktestDeps> = {},
): Promise<BacktestResult> {
  const getBarsRange = deps.getBarsRange ?? defaultGetBarsRange;
  const warnings: string[] = [];
  const trades: BacktestTrade[] = [];

  const ladder: Ladder = {
    noNewEntries: parseEtTime(params.noNewEntriesAfter),
    closeLosers: parseEtTime(params.closeLosersAt),
    halve: parseEtTime(params.halveAt),
    closeAll: parseEtTime(params.closeAllAt),
    sweep: parseEtTime(params.marketSweepAt),
  };

  // Sessions are interleaved across underlyings so a single equity curve
  // compounds in true chronological order rather than per-symbol blocks.
  const allSessions: { underlying: string; session: Session; iv: number }[] = [];
  let sessionsScanned = 0;

  for (const underlying of params.underlyings) {
    const [minuteBars, dailyBars] = await Promise.all([
      getBarsRange(underlying, "1Min", params.start, params.end, MAX_BARS_PER_SYMBOL, params.feed),
      getBarsRange(
        underlying,
        "1Day",
        shiftDays(params.start, -HV_HISTORY_PAD_DAYS),
        params.end,
        MAX_BARS_PER_SYMBOL,
        params.feed,
      ),
    ]);

    if (minuteBars.length === 0) {
      warnings.push(`${underlying}: no minute bars returned for ${params.start}..${params.end}`);
      continue;
    }

    // A truncated fetch silently shortens the window under test. Say so, loudly:
    // the equity curve would otherwise look complete over a range it never covered.
    const lastBarDate = minuteBars.at(-1)?.timestamp.slice(0, 10) ?? params.start;
    if (lastBarDate < params.end) {
      warnings.push(
        `${underlying}: minute bars stop at ${lastBarDate}, short of the requested end ${params.end} (${minuteBars.length} bars) — the window actually tested is shorter than the one requested`,
      );
    }

    const dailyCloses = dailyBars
      .map((b) => ({ date: b.timestamp.slice(0, 10), close: b.close }))
      .sort((a, b) => a.date.localeCompare(b.date));

    for (const session of groupSessions(minuteBars)) {
      sessionsScanned += 1;
      const iv = impliedVolFor(
        dailyCloses,
        session.date,
        params.hvLookbackDays,
        params.ivMultiplier,
      );
      if (iv == null) {
        warnings.push(
          `${underlying} ${session.date}: not enough prior daily closes for realised vol — session skipped rather than priced off a default IV`,
        );
        continue;
      }
      allSessions.push({ underlying, session, iv });
    }
  }

  allSessions.sort(
    (a, b) =>
      a.session.date.localeCompare(b.session.date) || a.underlying.localeCompare(b.underlying),
  );

  let equity = params.initialEquity;
  const equityCurve: EquityPoint[] = [{ timestamp: `${params.start}T00:00:00Z`, equity }];
  let sessionsWithTrigger = 0;

  for (const { underlying, session, iv } of allSessions) {
    const range = openingRange(session, params.openingRangeMinutes);
    if (!range || range.size <= 0) {
      continue;
    }

    const triggers = detectTriggers(session, range, {
      breakoutBufferPct: params.breakoutBufferPct,
      volumeMultiple: params.volumeMultiple,
      requireVwapAlign: params.requireVwapAlign,
      requirePriorCloseAlign: params.requirePriorCloseAlign,
      cutoffEtMinutes: ladder.noNewEntries,
    });
    if (triggers.length === 0) {
      continue;
    }
    sessionsWithTrigger += 1;

    let taken = 0;
    let cursor = 0;
    while (taken < params.maxTradesPerDay && cursor < triggers.length) {
      const trigger = triggers[cursor];
      const opened = openPosition(trigger, session, range, underlying, iv, equity, params);
      if (opened.warning) {
        warnings.push(opened.warning);
      }
      if (!opened.position) {
        cursor += 1;
        continue;
      }

      const trade = walkPosition(opened.position, session, ladder, params, equity);
      trades.push(trade);
      equity = trade.equityAfter;
      equityCurve.push({
        timestamp: trade.exits.at(-1)?.timestamp ?? trade.entryTimestamp,
        equity,
      });
      taken += 1;

      // A completed move is not a fresh setup: only a stop leaves the thesis
      // open enough to try again. Without this the next high-volume bar is
      // still beyond the range, and the re-entry chases the extension.
      if (trade.exits.at(-1)?.reason !== "stop" && !params.allowReentryAfterTarget) {
        break;
      }

      // Re-entries only from a trigger that fires after the position closed.
      const closedAt = trade.exits.at(-1)?.timestamp ?? trade.entryTimestamp;
      cursor = triggers.findIndex((t) => t.timestamp > closedAt);
      if (cursor === -1) {
        break;
      }
    }
  }

  return {
    params,
    trades,
    equityCurve,
    stats: summarise(trades, params.initialEquity, equityCurve),
    sessionsScanned,
    sessionsWithTrigger,
    warnings,
  };
}

interface OpenAttempt {
  position: OpenPosition | null;
  warning?: string;
}

function openPosition(
  trigger: Trigger,
  session: Session,
  range: { high: number; low: number; size: number },
  underlying: string,
  iv: number,
  equity: number,
  params: BacktestParams,
): OpenAttempt {
  const entryBar = session.bars.find((b) => b.timestamp === trigger.timestamp);
  if (!entryBar) {
    return { position: null };
  }

  const t = tradingYears(MARKET_CLOSE_ET - entryBar.etMinutes);
  const type: OptionType = trigger.direction === "long" ? "call" : "put";
  const step = params.strikeStep;

  const longStrike = strikeForDelta(
    type,
    trigger.spot,
    params.targetDelta,
    t,
    params.riskFreeRate,
    iv,
    step,
  );
  const rawWidth = params.widthMode === "range" ? range.size : params.fixedWidth;
  const width = Math.max(step, Math.round(rawWidth / step) * step);
  const shortStrike = type === "call" ? longStrike + width : longStrike - width;
  if (shortStrike <= 0) {
    return { position: null };
  }

  const theo = verticalValue(
    type,
    trigger.spot,
    longStrike,
    shortStrike,
    t,
    params.riskFreeRate,
    iv,
  );
  const entryDebit = theo + 2 * params.frictionPerLeg;
  const ratio = entryDebit / width;
  // A 0.45-delta vertical prices near half its width. Far outside that band the
  // inputs are wrong (a degenerate range, a bad IV), and sizing off the debit
  // would buy an implausible number of contracts.
  if (ratio < MIN_DEBIT_RATIO || ratio > MAX_DEBIT_RATIO) {
    return {
      position: null,
      warning: `${underlying} ${session.date}: debit/width ${ratio.toFixed(2)} outside [${MIN_DEBIT_RATIO}, ${MAX_DEBIT_RATIO}] — no trade`,
    };
  }

  const contracts = Math.floor((equity * params.riskPerTradePct) / (entryDebit * 100));
  if (contracts < 1) {
    return {
      position: null,
      warning: `${underlying} ${session.date}: debit ${entryDebit.toFixed(2)} too large to size even one contract at ${(params.riskPerTradePct * 100).toFixed(1)}% of equity`,
    };
  }

  return {
    position: {
      underlying,
      date: session.date,
      direction: trigger.direction,
      type,
      entryTimestamp: trigger.timestamp,
      entrySpot: trigger.spot,
      rangeHigh: range.high,
      rangeLow: range.low,
      rangeSize: range.size,
      longStrike,
      shortStrike,
      width,
      iv,
      entryDebit,
      contracts,
      riskAmount: entryDebit * 100 * contracts,
      remaining: 1,
      exits: [],
      maxFavorable: theo,
      maxAdverse: theo,
      scaledOut: false,
    },
  };
}

function walkPosition(
  position: OpenPosition,
  session: Session,
  ladder: Ladder,
  params: BacktestParams,
  equityBefore: number,
): BacktestTrade {
  const { riskFreeRate: rate } = params;
  /** Value actually received per spread after crossing both legs. */
  const netExit = (theo: number) => Math.max(0, theo - 2 * params.frictionPerLeg);
  const maxProfit = position.width - position.entryDebit;
  // The stop sits `stopBufferPct` of a range *inside* the range, not on its edge.
  const stopLevel =
    position.direction === "long"
      ? position.rangeHigh - params.stopBufferPct * position.rangeSize
      : position.rangeLow + params.stopBufferPct * position.rangeSize;
  const scaleOutValue = position.entryDebit + params.scaleOutAtMaxProfitPct * maxProfit;

  const close = (bar: SessionBar, fraction: number, value: number, reason: ExitReason) => {
    const share = Math.min(fraction, position.remaining);
    if (share <= 0) {
      return;
    }
    position.exits.push({
      timestamp: bar.timestamp,
      spot: bar.close,
      fraction: share,
      value,
      reason,
    });
    position.remaining -= share;
  };

  const after = session.bars.filter((b) => b.timestamp > position.entryTimestamp);

  for (const bar of after) {
    if (position.remaining <= 0) {
      break;
    }
    const t = tradingYears(MARKET_CLOSE_ET - bar.etMinutes);
    const value = verticalValue(
      position.type,
      bar.close,
      position.longStrike,
      position.shortStrike,
      t,
      rate,
      position.iv,
    );
    position.maxFavorable = Math.max(position.maxFavorable, value);
    position.maxAdverse = Math.min(position.maxAdverse, value);

    // 1. Structural stop, checked first: the bar's extremes give no ordering, so
    //    the adverse one is assumed to have come first.
    const stopped = position.direction === "long" ? bar.low <= stopLevel : bar.high >= stopLevel;
    if (stopped) {
      const atStop = verticalValue(
        position.type,
        stopLevel,
        position.longStrike,
        position.shortStrike,
        t,
        rate,
        position.iv,
      );
      close(
        bar,
        position.remaining,
        Math.min(netExit(atStop), position.entryDebit * params.stopRecoveryPct),
        "stop",
      );
      break;
    }

    // 2. Flatten ladder.
    const pnlPerSpread = value - position.entryDebit;
    if (bar.etMinutes >= ladder.sweep) {
      close(bar, position.remaining, netExit(value), "market_sweep");
      break;
    }
    if (bar.etMinutes >= ladder.closeAll) {
      close(bar, position.remaining, netExit(value), "flatten_all");
      break;
    }
    if (bar.etMinutes >= ladder.halve && position.remaining > 0.5) {
      close(bar, position.remaining / 2, netExit(value), "flatten_halve");
      continue;
    }
    if (bar.etMinutes >= ladder.closeLosers && pnlPerSpread < 0.25 * maxProfit) {
      close(bar, position.remaining, netExit(value), "flatten_loser");
      break;
    }

    // 3. Target: the underlying reaches the short strike, where the vertical is
    //    at (or near) its maximum. This is the same price as one range
    //    extension, by construction of the width.
    const reachedTarget =
      position.direction === "long"
        ? bar.high >= position.shortStrike
        : bar.low <= position.shortStrike;
    if (reachedTarget) {
      const atTarget = verticalValue(
        position.type,
        position.shortStrike,
        position.longStrike,
        position.shortStrike,
        t,
        rate,
        position.iv,
      );
      close(bar, position.remaining, netExit(atTarget), "target");
      break;
    }

    // 4. Scale-out, once, on the remainder.
    if (!position.scaledOut && params.scaleOutFraction > 0 && value >= scaleOutValue) {
      position.scaledOut = true;
      close(bar, params.scaleOutFraction, netExit(value), "scale_out");
    }
  }

  if (position.remaining > 0) {
    const last = after.at(-1) ?? session.bars.at(-1);
    if (last) {
      const intrinsic =
        optionPrice(position.type, last.close, position.longStrike, 0, rate, position.iv) -
        optionPrice(position.type, last.close, position.shortStrike, 0, rate, position.iv);
      close(last, position.remaining, netExit(Math.max(0, intrinsic)), "expiry");
    }
  }

  const weight = position.exits.reduce((a, e) => a + e.fraction, 0);
  const avgExitValue =
    weight > 0 ? position.exits.reduce((a, e) => a + e.fraction * e.value, 0) / weight : 0;
  const pnl = (avgExitValue - position.entryDebit) * 100 * position.contracts;

  return {
    id: `${position.underlying}-${position.date}-${position.entryTimestamp}`,
    underlying: position.underlying,
    date: position.date,
    direction: position.direction,
    kind: position.direction === "long" ? "bull_call_spread" : "bear_put_spread",
    entryTimestamp: position.entryTimestamp,
    entrySpot: position.entrySpot,
    rangeHigh: position.rangeHigh,
    rangeLow: position.rangeLow,
    rangeSize: position.rangeSize,
    longStrike: position.longStrike,
    shortStrike: position.shortStrike,
    width: position.width,
    iv: position.iv,
    entryDebit: position.entryDebit,
    contracts: position.contracts,
    riskAmount: position.riskAmount,
    exits: position.exits,
    avgExitValue,
    pnl,
    rMultiple: position.riskAmount > 0 ? pnl / position.riskAmount : 0,
    equityAfter: equityBefore + pnl,
    maxFavorable: position.maxFavorable,
    maxAdverse: position.maxAdverse,
  };
}

export function summarise(
  trades: BacktestTrade[],
  initialEquity: number,
  equityCurve: EquityPoint[],
): BacktestStats {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss =
    losses.length > 0 ? Math.abs(losses.reduce((a, t) => a + t.pnl, 0) / losses.length) : 0;
  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : 0;

  let peak = initialEquity;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    maxDrawdown = Math.max(maxDrawdown, peak - point.equity);
  }

  const byUnderlying: BacktestStats["byUnderlying"] = {};
  for (const trade of trades) {
    const entry = byUnderlying[trade.underlying] ?? { trades: 0, pnl: 0, hitRate: 0 };
    entry.trades += 1;
    entry.pnl += trade.pnl;
    byUnderlying[trade.underlying] = entry;
  }
  for (const [symbol, entry] of Object.entries(byUnderlying)) {
    const symbolWins = trades.filter((t) => t.underlying === symbol && t.pnl > 0).length;
    entry.hitRate = entry.trades > 0 ? symbolWins / entry.trades : 0;
  }

  const byExitReason: Record<string, number> = {};
  for (const trade of trades) {
    for (const exit of trade.exits) {
      byExitReason[exit.reason] = (byExitReason[exit.reason] ?? 0) + 1;
    }
  }

  const finalEquity = initialEquity + totalPnl;
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    hitRate: trades.length > 0 ? wins.length / trades.length : 0,
    avgWin,
    avgLoss,
    payoffRatio,
    // The number the signal has to beat: 1 / (1 + payoff).
    breakEvenHitRate: payoffRatio > 0 ? 1 / (1 + payoffRatio) : 1,
    expectancy: trades.length > 0 ? totalPnl / trades.length : 0,
    totalPnl,
    finalEquity,
    returnPct: initialEquity > 0 ? totalPnl / initialEquity : 0,
    maxDrawdown,
    maxDrawdownPct: initialEquity > 0 ? maxDrawdown / initialEquity : 0,
    targetReachedRate:
      trades.length > 0
        ? trades.filter((t) => t.exits.some((e) => e.reason === "target")).length / trades.length
        : 0,
    byUnderlying,
    byExitReason,
  };
}
