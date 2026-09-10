import "server-only";

import type { EquityPoint } from "@/domain/backtest";
import type {
  CompactBar,
  PricePoint,
  TriangleBacktestParams,
  TriangleBacktestResult,
  TriangleExitReason,
  TriangleFunnel,
  TriangleGeometry,
  TriangleStats,
  TriangleTrade,
} from "@/domain/backtest-triangle";
import type { Bar } from "@/domain/types";
import { getBarsRange as defaultGetBarsRange } from "@/server/alpaca/rest";
import {
  optionPrice,
  strikeForDelta,
  TRADING_MINUTES_PER_SESSION,
  tradingYears,
} from "./black-scholes";
import { type BacktestDeps, impliedVolFor, shiftDays } from "./engine";
import { detectTriangleBreakouts, type Pivot, supportAt, type TriangleBreakout } from "./triangle";

/**
 * Joins the triangle signal (`triangle.ts`) to a long call structure priced with
 * Black-Scholes, and walks a portfolio through it one session at a time.
 *
 * Choices that move the result, each on the pessimistic side:
 *
 * - **Entry at the next open.** The breakout is only known at the close that
 *   makes it, so the position is opened at the following session's open,
 *   gap included. Filling at the breakout close would bank a move the signal
 *   could not have seen.
 * - **Exits at the close, stop first.** Stop and target are levels on the
 *   underlying. A daily bar does not say which came first, so a session that
 *   touches the target but closes under the stop is a stop.
 * - **Risk = the full debit.** A long premium position can lose all of it; the
 *   stop usually recovers some, but sizing does not count on it.
 *
 * Time to expiry is in trading sessions × 390 minutes through `tradingYears`,
 * on the same 252-session calendar realised vol is annualised on — never
 * `yearsBetween` (see AGENTS.md). Exchange holidays are counted as sessions.
 */

/** Calendar days of daily history fetched before `start`: pattern lookback + realised vol. */
const HISTORY_PAD_DAYS = 200;
const MAX_BARS_PER_SYMBOL = 10_000;
/** A spread priced outside this share of its width means broken inputs, not a trade. */
const MIN_DEBIT_RATIO = 0.05;
const MAX_DEBIT_RATIO = 0.95;
const DAY_MS = 86_400_000;

interface Series {
  underlying: string;
  bars: Bar[];
  indexByDate: Map<string, number>;
  closes: { date: string; close: number }[];
}

interface OpenPosition {
  series: Series;
  breakout: TriangleBreakout;
  geometry: TriangleGeometry;
  entryDate: string;
  entryTimestamp: string;
  entrySpot: number;
  expiration: string;
  dteAtEntry: number;
  longStrike: number;
  shortStrike: number | null;
  width: number | null;
  iv: number;
  entryDebit: number;
  contracts: number;
  riskAmount: number;
  stopLevel: number;
  holdingDays: number;
  targetReached: boolean;
  maxFavorable: number;
  maxAdverse: number;
  lastMark: number;
}

const dateOf = (bar: Bar) => bar.timestamp.slice(0, 10);

function calendarDaysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** Weekday sessions from `from` to `to`, both inclusive. Exchange holidays are not modelled. */
export function sessionsBetween(from: string, to: string): number {
  let count = 0;
  const day = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (day <= end) {
    const weekday = day.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      count += 1;
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return count;
}

/** First Friday on or after `date + dteDays` — the standard weekly/monthly expiry. */
export function expirationFor(date: string, dteDays: number): string {
  const day = new Date(`${shiftDays(date, dteDays)}T00:00:00Z`);
  while (day.getUTCDay() !== 5) {
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return day.toISOString().slice(0, 10);
}

const STRIKE_LADDER = [0.5, 1, 2.5, 5, 10];

/** Strike grid near 0.5% of spot, snapped to the usual listed increments. An approximation. */
export function autoStrikeStep(spot: number): number {
  const raw = spot * 0.005;
  return STRIKE_LADDER.reduce((best, step) =>
    Math.abs(step - raw) < Math.abs(best - raw) ? step : best,
  );
}

function toPoint(pivot: Pivot): PricePoint {
  return { timestamp: pivot.timestamp, price: pivot.price };
}

function geometryOf(breakout: TriangleBreakout, bars: Bar[]): TriangleGeometry {
  const firstLow = breakout.lows[0];
  return {
    startTimestamp: bars[breakout.startIndex].timestamp,
    resistance: breakout.resistance,
    touches: breakout.touches.map(toPoint),
    lows: breakout.lows.map(toPoint),
    support: {
      from: { timestamp: firstLow.timestamp, price: supportAt(breakout, firstLow.index) },
      to: { timestamp: breakout.timestamp, price: supportAt(breakout, breakout.index) },
    },
    height: breakout.height,
    target: breakout.target,
    breakoutTimestamp: breakout.timestamp,
    breakoutClose: breakout.close,
    volumeRatio: breakout.volumeRatio,
  };
}

function toCompact(bar: Bar): CompactBar {
  return [
    Math.floor(Date.parse(bar.timestamp) / 1000),
    bar.open,
    bar.high,
    bar.low,
    bar.close,
    bar.volume,
  ];
}

export async function runTriangleBacktest(
  params: TriangleBacktestParams,
  deps: Partial<BacktestDeps> = {},
): Promise<TriangleBacktestResult> {
  const getBarsRange = deps.getBarsRange ?? defaultGetBarsRange;
  const warnings: string[] = [];
  const funnel: TriangleFunnel = {
    breakouts: 0,
    rejectedVolume: 0,
    skippedData: 0,
    skippedCapacity: 0,
    skippedStructure: 0,
    skippedSizing: 0,
    taken: 0,
  };

  const fetchStart = shiftDays(params.start, -HISTORY_PAD_DAYS);
  const symbols = [...new Set([...params.underlyings, params.benchmark])];
  const fetched = await Promise.all(
    symbols.map((symbol) =>
      getBarsRange(symbol, "1Day", fetchStart, params.end, MAX_BARS_PER_SYMBOL, params.feed),
    ),
  );

  const seriesBySymbol = new Map<string, Series>();
  symbols.forEach((symbol, i) => {
    const bars = [...fetched[i]].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    if (bars.length === 0) {
      warnings.push(`${symbol}: no daily bars returned for ${fetchStart}..${params.end}`);
      return;
    }
    const lastDate = dateOf(bars[bars.length - 1]);
    // A weekend or holiday `end` legitimately has no bar; a week's gap does not.
    if (calendarDaysBetween(lastDate, params.end) > 4) {
      warnings.push(
        `${symbol}: daily bars stop at ${lastDate}, short of the requested end ${params.end} — the window actually tested is shorter`,
      );
    }
    seriesBySymbol.set(symbol, {
      underlying: symbol,
      bars,
      indexByDate: new Map(bars.map((b, index) => [dateOf(b), index])),
      closes: bars.map((b) => ({ date: dateOf(b), close: b.close })),
    });
  });

  const tradedSeries = params.underlyings
    .map((u) => seriesBySymbol.get(u))
    .filter((s): s is Series => s != null);

  // --- Layer 1: breakouts, keyed by the date they can be entered on ---------
  const pendingByDate = new Map<string, { series: Series; breakout: TriangleBreakout }[]>();
  for (const series of tradedSeries) {
    const detection = detectTriangleBreakouts(series.bars, params);
    const inWindow = (timestamp: string) =>
      timestamp.slice(0, 10) >= params.start && timestamp.slice(0, 10) <= params.end;

    funnel.rejectedVolume += detection.rejectedVolume.filter((r) => inWindow(r.timestamp)).length;

    for (const breakout of detection.breakouts) {
      if (!inWindow(breakout.timestamp)) {
        continue;
      }
      funnel.breakouts += 1;
      const entryBar = series.bars[breakout.index + 1];
      if (!entryBar || dateOf(entryBar) > params.end) {
        funnel.skippedData += 1;
        continue;
      }
      const list = pendingByDate.get(dateOf(entryBar)) ?? [];
      list.push({ series, breakout });
      pendingByDate.set(dateOf(entryBar), list);
    }
  }

  // --- Layer 2: the portfolio, one session at a time ------------------------
  const calendar = [
    ...new Set(
      tradedSeries.flatMap((s) =>
        s.closes.map((c) => c.date).filter((d) => d >= params.start && d <= params.end),
      ),
    ),
  ].sort();

  const trades: TriangleTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const open: OpenPosition[] = [];
  let cash = params.initialEquity;
  let equity = params.initialEquity;

  const legFriction = (price: number) =>
    Math.max(params.minFrictionPerLeg, price * params.frictionPct);

  /** Model value of the structure and the friction to cross it, per share. */
  const priceStructure = (
    pos: { longStrike: number; shortStrike: number | null; iv: number },
    spot: number,
    sessionsLeft: number,
  ) => {
    const t = tradingYears(sessionsLeft * TRADING_MINUTES_PER_SESSION);
    const long = optionPrice("call", spot, pos.longStrike, t, params.riskFreeRate, pos.iv);
    if (pos.shortStrike == null) {
      return { theo: long, friction: legFriction(long) };
    }
    const short = optionPrice("call", spot, pos.shortStrike, t, params.riskFreeRate, pos.iv);
    const width = pos.shortStrike - pos.longStrike;
    return {
      theo: Math.min(Math.max(long - short, 0), width),
      friction: legFriction(long) + legFriction(short),
    };
  };

  const tryOpen = (series: Series, breakout: TriangleBreakout, date: string) => {
    if (
      open.length >= params.maxOpenPositions ||
      open.some((p) => p.series.underlying === series.underlying)
    ) {
      funnel.skippedCapacity += 1;
      return;
    }
    const index = series.indexByDate.get(date);
    if (index == null) {
      funnel.skippedData += 1;
      return;
    }
    const bar = series.bars[index];
    const spot = bar.open;
    const label = `${series.underlying} ${date}`;

    if (spot >= breakout.target) {
      funnel.skippedStructure += 1;
      warnings.push(`${label}: opened at ${spot.toFixed(2)}, already past the target — no trade`);
      return;
    }

    const iv = impliedVolFor(series.closes, date, params.hvLookbackDays, params.ivMultiplier);
    if (iv == null) {
      funnel.skippedData += 1;
      warnings.push(
        `${label}: not enough prior daily closes for realised vol — skipped rather than priced off a default IV`,
      );
      return;
    }

    const expiration = expirationFor(date, params.dteDays);
    const sessionsAtOpen = sessionsBetween(date, expiration);
    const t = tradingYears(sessionsAtOpen * TRADING_MINUTES_PER_SESSION);
    const step = params.strikeStep ?? autoStrikeStep(spot);
    const longStrike = strikeForDelta(
      "call",
      spot,
      params.targetDelta,
      t,
      params.riskFreeRate,
      iv,
      step,
    );

    let shortStrike: number | null = null;
    if (params.structure === "bull_call_spread") {
      const objective =
        params.shortStrikeMode === "measured"
          ? breakout.target
          : spot * (1 + params.shortStrikePct);
      shortStrike = Math.max(longStrike + step, Math.ceil(objective / step) * step);
    }

    const { theo, friction } = priceStructure(
      { longStrike, shortStrike, iv },
      spot,
      sessionsAtOpen,
    );
    const entryDebit = theo + friction;
    const width = shortStrike == null ? null : shortStrike - longStrike;

    if (width != null) {
      const ratio = entryDebit / width;
      if (ratio < MIN_DEBIT_RATIO || ratio > MAX_DEBIT_RATIO) {
        funnel.skippedStructure += 1;
        warnings.push(
          `${label}: debit/width ${ratio.toFixed(2)} outside [${MIN_DEBIT_RATIO}, ${MAX_DEBIT_RATIO}] — no trade`,
        );
        return;
      }
    } else if (entryDebit < 0.05) {
      funnel.skippedStructure += 1;
      warnings.push(`${label}: long call priced at ${entryDebit.toFixed(2)} — no trade`);
      return;
    }

    const contracts = Math.floor((equity * params.riskPerTradePct) / (entryDebit * 100));
    if (contracts < 1) {
      funnel.skippedSizing += 1;
      warnings.push(
        `${label}: debit ${entryDebit.toFixed(2)} too large to size one contract at ${(params.riskPerTradePct * 100).toFixed(1)}% of equity`,
      );
      return;
    }

    funnel.taken += 1;
    cash -= entryDebit * 100 * contracts;
    open.push({
      series,
      breakout,
      geometry: geometryOf(breakout, series.bars),
      entryDate: date,
      entryTimestamp: bar.timestamp,
      entrySpot: spot,
      expiration,
      dteAtEntry: calendarDaysBetween(date, expiration),
      longStrike,
      shortStrike,
      width,
      iv,
      entryDebit,
      contracts,
      riskAmount: entryDebit * 100 * contracts,
      stopLevel: stopLevelAt(breakout, index),
      holdingDays: 0,
      targetReached: false,
      maxFavorable: theo,
      maxAdverse: theo,
      lastMark: theo,
    });
  };

  function stopLevelAt(breakout: TriangleBreakout, index: number): number {
    const base = params.stopMode === "support" ? supportAt(breakout, index) : breakout.resistance;
    return base * (1 - params.stopBufferPct);
  }

  const closePosition = (pos: OpenPosition, bar: Bar, spot: number, reason: TriangleExitReason) => {
    const date = dateOf(bar);
    const sessionsLeft = Math.max(0, sessionsBetween(date, pos.expiration) - 1);
    const { theo, friction } = priceStructure(pos, spot, sessionsLeft);
    const exitValue = Math.max(0, theo - friction);
    cash += exitValue * 100 * pos.contracts;
    const pnl = (exitValue - pos.entryDebit) * 100 * pos.contracts;

    trades.push({
      id: `${pos.series.underlying}-${pos.entryDate}`,
      underlying: pos.series.underlying,
      structure: params.structure,
      triangle: pos.geometry,
      entryDate: pos.entryDate,
      entryTimestamp: pos.entryTimestamp,
      entrySpot: pos.entrySpot,
      expiration: pos.expiration,
      dteAtEntry: pos.dteAtEntry,
      longStrike: pos.longStrike,
      shortStrike: pos.shortStrike,
      width: pos.width,
      iv: pos.iv,
      entryDebit: pos.entryDebit,
      contracts: pos.contracts,
      riskAmount: pos.riskAmount,
      stopLevel: pos.stopLevel,
      exitDate: date,
      exitTimestamp: bar.timestamp,
      exitSpot: spot,
      exitValue,
      exitReason: reason,
      holdingDays: pos.holdingDays,
      targetReached: pos.targetReached,
      pnl,
      rMultiple: pos.riskAmount > 0 ? pnl / pos.riskAmount : 0,
      equityAfter: 0, // filled in once the session is marked
      maxFavorable: pos.maxFavorable,
      maxAdverse: pos.maxAdverse,
    });
    open.splice(open.indexOf(pos), 1);
  };

  calendar.forEach((date, dayIndex) => {
    const isLast = dayIndex === calendar.length - 1;
    const closedToday = trades.length;

    // 1. Entries at the open. When the book cannot take them all, the loudest
    //    breakout (volume ratio) goes first — deterministic, and it is the
    //    filter the signal already trusts.
    const pending = [...(pendingByDate.get(date) ?? [])].sort(
      (a, b) =>
        b.breakout.volumeRatio - a.breakout.volumeRatio ||
        a.series.underlying.localeCompare(b.series.underlying),
    );
    for (const { series, breakout } of pending) {
      tryOpen(series, breakout, date);
    }

    // 2. Exits at the close.
    for (const pos of [...open]) {
      const index = pos.series.indexByDate.get(date);
      if (index == null) {
        continue;
      }
      const bar = pos.series.bars[index];
      pos.holdingDays += 1;
      const sessionsLeft = Math.max(0, sessionsBetween(date, pos.expiration) - 1);
      const mark = priceStructure(pos, bar.close, sessionsLeft).theo;
      pos.lastMark = mark;
      pos.maxFavorable = Math.max(pos.maxFavorable, mark);
      pos.maxAdverse = Math.min(pos.maxAdverse, mark);
      const target = pos.breakout.target;
      if (bar.high >= target) {
        pos.targetReached = true;
      }

      if (bar.close < stopLevelAt(pos.breakout, index)) {
        closePosition(pos, bar, bar.close, "stop");
      } else if (bar.high >= target) {
        // A gap over the target fills at the open, not back down at the level.
        closePosition(pos, bar, Math.max(target, bar.open), "target");
      } else if (
        pos.width != null &&
        mark >= pos.entryDebit + params.takeProfitPctOfMax * (pos.width - pos.entryDebit)
      ) {
        closePosition(pos, bar, bar.close, "take_profit");
      } else if (pos.holdingDays >= params.maxHoldDays) {
        closePosition(pos, bar, bar.close, "time_stop");
      } else if (calendarDaysBetween(date, pos.expiration) <= params.exitDteFloor) {
        closePosition(pos, bar, bar.close, "dte_floor");
      } else if (isLast) {
        closePosition(pos, bar, bar.close, "end_of_data");
      }
    }

    // A position whose underlying printed nothing on the last session still has
    // to be closed, at its most recent bar.
    if (isLast) {
      for (const pos of [...open]) {
        const bars = pos.series.bars.filter((b) => dateOf(b) <= date);
        const bar = bars[bars.length - 1];
        closePosition(pos, bar, bar.close, "end_of_data");
      }
    }

    // 3. Mark the book to model at the close.
    equity = cash + open.reduce((sum, pos) => sum + pos.lastMark * 100 * pos.contracts, 0);
    for (const trade of trades.slice(closedToday)) {
      trade.equityAfter = equity;
    }
    equityCurve.push({ timestamp: `${date}T20:00:00Z`, equity });
  });

  const benchmarkCurve = buildBenchmark(
    seriesBySymbol.get(params.benchmark),
    calendar,
    params.initialEquity,
  );
  if (benchmarkCurve.length === 0 && calendar.length > 0) {
    warnings.push(`${params.benchmark}: no benchmark bars — comparison omitted`);
  }

  const barsByUnderlying: Record<string, CompactBar[]> = {};
  for (const underlying of new Set(trades.map((t) => t.underlying))) {
    const series = seriesBySymbol.get(underlying);
    if (series) {
      barsByUnderlying[underlying] = series.bars.map(toCompact);
    }
  }

  return {
    params,
    trades,
    equityCurve,
    benchmarkCurve,
    stats: summariseTriangle(trades, params.initialEquity, equityCurve, benchmarkCurve),
    funnel,
    barsByUnderlying,
    sessionsScanned: calendar.length,
    warnings,
  };
}

/** Buy-and-hold, scaled to the starting equity, carried forward over gaps. */
function buildBenchmark(
  series: Series | undefined,
  calendar: string[],
  initialEquity: number,
): EquityPoint[] {
  if (!series || calendar.length === 0) {
    return [];
  }
  const closeByDate = new Map(series.closes.map((c) => [c.date, c.close]));
  const first = calendar.map((d) => closeByDate.get(d)).find((c) => c != null);
  if (first == null) {
    return [];
  }
  let last = first;
  return calendar.map((date) => {
    last = closeByDate.get(date) ?? last;
    return { timestamp: `${date}T20:00:00Z`, equity: (initialEquity * last) / first };
  });
}

function drawdown(curve: EquityPoint[]): { amount: number; pct: number } {
  let peak = curve[0]?.equity ?? 0;
  let amount = 0;
  let pct = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.equity);
    amount = Math.max(amount, peak - point.equity);
    pct = Math.max(pct, peak > 0 ? (peak - point.equity) / peak : 0);
  }
  return { amount, pct };
}

export function summariseTriangle(
  trades: TriangleTrade[],
  initialEquity: number,
  equityCurve: EquityPoint[],
  benchmarkCurve: EquityPoint[] = [],
): TriangleStats {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss =
    losses.length > 0 ? Math.abs(losses.reduce((a, t) => a + t.pnl, 0) / losses.length) : 0;
  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : 0;
  const finalEquity = equityCurve.at(-1)?.equity ?? initialEquity;

  const first = equityCurve[0];
  const last = equityCurve.at(-1);
  const spanDays =
    first && last ? (Date.parse(last.timestamp) - Date.parse(first.timestamp)) / DAY_MS : 0;
  const cagr =
    spanDays >= 1 && initialEquity > 0 && finalEquity > 0
      ? (finalEquity / initialEquity) ** (365.25 / spanDays) - 1
      : null;

  const returns: number[] = [];
  let previous = initialEquity;
  for (const point of equityCurve) {
    if (previous > 0) {
      returns.push(point.equity / previous - 1);
    }
    previous = point.equity;
  }
  const meanReturn = returns.reduce((a, r) => a + r, 0) / Math.max(1, returns.length);
  const variance =
    returns.length > 1
      ? returns.reduce((a, r) => a + (r - meanReturn) ** 2, 0) / (returns.length - 1)
      : 0;
  const sharpe = variance > 0 ? (meanReturn / Math.sqrt(variance)) * Math.sqrt(252) : null;

  const { amount: maxDrawdown, pct: maxDrawdownPct } = drawdown(equityCurve);

  const byUnderlying: TriangleStats["byUnderlying"] = {};
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
    byExitReason[trade.exitReason] = (byExitReason[trade.exitReason] ?? 0) + 1;
  }

  const benchFirst = benchmarkCurve[0]?.equity;
  const benchLast = benchmarkCurve.at(-1)?.equity;

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    hitRate: trades.length > 0 ? wins.length / trades.length : 0,
    avgWin,
    avgLoss,
    payoffRatio,
    breakEvenHitRate: payoffRatio > 0 ? 1 / (1 + payoffRatio) : 1,
    expectancy: trades.length > 0 ? totalPnl / trades.length : 0,
    avgR: trades.length > 0 ? trades.reduce((a, t) => a + t.rMultiple, 0) / trades.length : 0,
    totalPnl,
    finalEquity,
    returnPct: initialEquity > 0 ? (finalEquity - initialEquity) / initialEquity : 0,
    cagr,
    sharpe,
    maxDrawdown,
    maxDrawdownPct,
    avgHoldingDays:
      trades.length > 0 ? trades.reduce((a, t) => a + t.holdingDays, 0) / trades.length : 0,
    targetReachedRate:
      trades.length > 0 ? trades.filter((t) => t.targetReached).length / trades.length : 0,
    benchmarkReturnPct:
      benchFirst != null && benchLast != null && benchFirst > 0 ? benchLast / benchFirst - 1 : null,
    benchmarkMaxDrawdownPct: benchmarkCurve.length > 0 ? drawdown(benchmarkCurve).pct : null,
    byUnderlying,
    byExitReason,
  };
}
