import "server-only";

import { daysBetweenDates } from "@/config/competition";
import type {
  CreditBacktestParams,
  CreditBacktestResult,
  CreditExitReason,
  CreditGateRejection,
  CreditTrade,
  EquityPoint,
  SpreadSide,
} from "@/domain/backtest-credit";
import type { Bar } from "@/domain/types";
import { getBarsRange as defaultGetBarsRange } from "@/server/alpaca/rest";
import {
  creditSpreadValue,
  type OptionType,
  realisedVolatility,
  TRADING_MINUTES_PER_SESSION,
  tradingYears,
} from "./black-scholes";
import { summariseCredit } from "./credit-spread-stats";
import { groupSessions, MARKET_CLOSE_ET, parseEtTime, type Session, type SessionBar } from "./orb";

export interface CreditBacktestDeps {
  getBarsRange: (
    symbol: string,
    timeframe: "1Min" | "1Day",
    start: string,
    end: string,
    maxPerSymbol?: number,
    feed?: "iex" | "sip",
  ) => Promise<Bar[]>;
}

export const HV_HISTORY_PAD_DAYS = 200;
export const MAX_BARS_PER_SYMBOL = 400_000;
/** A short vertical at 0.175 delta cannot credibly pay this share of its width. */
export const MAX_CREDIT_RATIO = 0.6;
/** Minutes after the decision window in which a late first bar may still be used. */
export const ENTRY_TOLERANCE_MINUTES = 30;

export interface SymbolData {
  underlying: string;
  sessions: Session[];
  indexByDate: Map<string, number>;
  /** Annualised realised vol for the session, from strictly prior closes. */
  ivByDate: Map<string, number>;
}

export interface Tick {
  underlying: string;
  date: string;
  sessionIndex: number;
  bar: SessionBar;
}

export interface OpenSpread {
  id: string;
  underlying: string;
  date: string;
  side: SpreadSide;
  type: OptionType;
  entryTimestamp: string;
  entrySpot: number;
  expiration: string;
  expirySessionIndex: number;
  dte: number;
  shortStrike: number;
  longStrike: number;
  width: number;
  iv: number;
  shortDelta: number;
  /** Net share-equivalent delta of the whole spread, per contract. */
  netDeltaShares: number;
  credit: number;
  maxLoss: number;
  contracts: number;
  riskAmount: number;
  entryMinutesToExpiry: number;
  lastCost: number;
  minCost: number;
  maxCost: number;
}

export interface MutableBook {
  open: OpenSpread[];
  bpUsed: number;
  netDeltaShares: number;
  dayRisk: number;
  equity: number;
}

export interface EntryOpportunity {
  underlying: string;
  date: string;
  sessionIndex: number;
  bar: SessionBar;
  symbol: SymbolData;
  baseIv: number;
  expiration: string;
  expirySessionIndex: number;
  dte: number;
  minutes: number;
  t: number;
  spot: number;
  width: number;
  sides: SpreadSide[];
}

export type RejectFn = (reason: string) => void;

export interface EntryHandlerContext {
  book: MutableBook;
  params: CreditBacktestParams;
  opportunity: EntryOpportunity;
  reject: RejectFn;
  rejectionLog: CreditGateRejection[];
  sessionsWithEntry: Set<string>;
}

export type EntryHandler = (ctx: EntryHandlerContext) => void;

function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Trading minutes from a bar to the 16:00 ET close of the expiry session.
 * Valid because the session list is built from bars that actually printed, so
 * consecutive indices are consecutive trading days.
 */
export function minutesToExpiry(
  sessionIndex: number,
  etMinutes: number,
  expirySessionIndex: number,
): number {
  return (
    MARKET_CLOSE_ET - etMinutes + TRADING_MINUTES_PER_SESSION * (expirySessionIndex - sessionIndex)
  );
}

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

export async function loadSymbol(
  underlying: string,
  params: CreditBacktestParams,
  getBarsRange: CreditBacktestDeps["getBarsRange"],
  warnings: string[],
): Promise<SymbolData | null> {
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
    return null;
  }

  const lastBarDate = minuteBars.at(-1)?.timestamp.slice(0, 10) ?? params.start;
  if (lastBarDate < params.end) {
    warnings.push(
      `${underlying}: minute bars stop at ${lastBarDate}, short of the requested end ${params.end} (${minuteBars.length} bars) — the window actually tested is shorter than the one requested`,
    );
  }

  const dailyCloses = dailyBars
    .map((b) => ({ date: b.timestamp.slice(0, 10), close: b.close }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const sessions = groupSessions(minuteBars);
  const indexByDate = new Map<string, number>();
  const ivByDate = new Map<string, number>();

  sessions.forEach((session, index) => {
    indexByDate.set(session.date, index);
    const iv = impliedVolFor(dailyCloses, session.date, params.hvLookbackDays, params.ivMultiplier);
    if (iv != null) {
      ivByDate.set(session.date, iv);
    }
  });

  return { underlying, sessions, indexByDate, ivByDate };
}

/**
 * IV for an open spread at a given spot: the entry IV, marked up as the
 * underlying falls. One-sided on purpose — a rally would lower IV and help both
 * short legs, and a backtest should not pay a premium seller for that.
 */
function markedIv(position: OpenSpread, spot: number, shockPerDownPct: number): number {
  const move = (spot - position.entrySpot) / position.entrySpot;
  return move < 0 ? position.iv * (1 + shockPerDownPct * (-move * 100)) : position.iv;
}

/** Cost to buy the spread back at `spot`, per share, including exit friction. */
export function buybackCost(
  position: OpenSpread,
  spot: number,
  minutes: number,
  params: CreditBacktestParams,
): number {
  const iv = markedIv(position, spot, params.ivShockPerDownPct);
  const value = creditSpreadValue(
    position.type,
    spot,
    position.shortStrike,
    position.longStrike,
    tradingYears(minutes),
    params.riskFreeRate,
    iv,
  );
  // Defined risk holds after friction too: the loss can never exceed the width.
  return Math.min(position.width, value + 2 * params.frictionPerLeg);
}

export async function runCreditSpreadEngine(
  params: CreditBacktestParams,
  handleEntry: EntryHandler,
  deps: Partial<CreditBacktestDeps> = {},
): Promise<CreditBacktestResult> {
  const getBarsRange = deps.getBarsRange ?? defaultGetBarsRange;
  const warnings: string[] = [];
  const rejections: Record<string, number> = {};
  const rejectionLog: CreditBacktestResult["rejectionLog"] = [];
  const reject = (reason: string) => {
    rejections[reason] = (rejections[reason] ?? 0) + 1;
  };

  if (params.minDte > params.maxDte) {
    warnings.push(`minDte ${params.minDte} exceeds maxDte ${params.maxDte} — no expiry can match`);
  }

  const entryEt = parseEtTime(params.entryTimeEt);
  const closeEt = parseEtTime(params.closeAtEt);
  const width = Math.max(
    params.strikeStep,
    Math.round(params.spreadWidth / params.strikeStep) * params.strikeStep,
  );
  const sides: SpreadSide[] =
    params.sides === "both" ? ["put", "call"] : [params.sides as SpreadSide];

  const symbols = new Map<string, SymbolData>();
  const timeline: Tick[] = [];
  let sessionsScanned = 0;

  for (const underlying of params.underlyings) {
    const data = await loadSymbol(underlying, params, getBarsRange, warnings);
    if (!data) {
      continue;
    }
    symbols.set(underlying, data);
    data.sessions.forEach((session, sessionIndex) => {
      sessionsScanned += 1;
      for (const bar of session.bars) {
        timeline.push({ underlying, date: session.date, sessionIndex, bar });
      }
    });
  }

  timeline.sort(
    (a, b) =>
      a.bar.timestamp.localeCompare(b.bar.timestamp) || a.underlying.localeCompare(b.underlying),
  );

  const trades: CreditTrade[] = [];
  const equityCurve: EquityPoint[] = [
    { timestamp: `${params.start}T00:00:00Z`, equity: params.initialEquity },
  ];

  const book: MutableBook = {
    open: [],
    bpUsed: 0,
    netDeltaShares: 0,
    dayRisk: 0,
    equity: params.initialEquity,
  };
  const { open } = book;
  let currentDate: string | null = null;
  let dayOpenEquity: number | null = null;
  let killed = false;
  const entered = new Set<string>();
  const sessionsWithEntry = new Set<string>();

  const settle = (
    position: OpenSpread,
    exit: CreditBacktestResult["trades"][0]["exit"],
    minutesLeft: number,
  ) => {
    const pnl = (position.credit - exit.cost) * 100 * position.contracts;
    book.equity += pnl;
    book.bpUsed -= position.riskAmount;
    book.netDeltaShares -= position.netDeltaShares * position.contracts;
    trades.push({
      id: position.id,
      underlying: position.underlying,
      date: position.date,
      side: position.side,
      entryTimestamp: position.entryTimestamp,
      entrySpot: position.entrySpot,
      expiration: position.expiration,
      dte: position.dte,
      shortStrike: position.shortStrike,
      longStrike: position.longStrike,
      width: position.width,
      iv: position.iv,
      shortDelta: position.shortDelta,
      credit: position.credit,
      maxLoss: position.maxLoss,
      contracts: position.contracts,
      riskAmount: position.riskAmount,
      exit,
      pnl,
      rMultiple: position.riskAmount > 0 ? pnl / position.riskAmount : 0,
      equityAfter: book.equity,
      minutesHeld: Math.max(0, position.entryMinutesToExpiry - minutesLeft),
      minCost: position.minCost,
      maxCost: position.maxCost,
    });
    equityCurve.push({ timestamp: exit.timestamp, equity: book.equity });
  };

  const closeNow = (
    position: OpenSpread,
    bar: SessionBar,
    minutesLeft: number,
    cost: number,
    reason: CreditExitReason,
  ) => {
    settle(position, { timestamp: bar.timestamp, spot: bar.close, cost, reason }, minutesLeft);
    const at = open.indexOf(position);
    if (at >= 0) {
      open.splice(at, 1);
    }
  };

  for (const tick of timeline) {
    const { bar, date, underlying, sessionIndex } = tick;

    if (date !== currentDate) {
      currentDate = date;
      book.dayRisk = 0;
      killed = false;
      dayOpenEquity = null;
    }

    for (const position of [...open]) {
      if (position.underlying !== underlying) {
        continue;
      }
      if (bar.timestamp <= position.entryTimestamp) {
        continue;
      }

      const minutesLeft = minutesToExpiry(sessionIndex, bar.etMinutes, position.expirySessionIndex);
      const mid = buybackCost(position, bar.close, minutesLeft, params);
      position.lastCost = mid;
      position.minCost = Math.min(position.minCost, mid);
      position.maxCost = Math.max(position.maxCost, mid);

      const positionSymbol = symbols.get(position.underlying);
      const expirySession = positionSymbol?.sessions[position.expirySessionIndex];
      const isLastBarOfExpirySession =
        sessionIndex === position.expirySessionIndex &&
        expirySession != null &&
        bar.timestamp === expirySession.bars.at(-1)?.timestamp;

      if (sessionIndex > position.expirySessionIndex || isLastBarOfExpirySession) {
        const intrinsicCost = buybackCost(position, bar.close, 0, params);
        closeNow(position, bar, 0, intrinsicCost, "expiry");
        if (sessionIndex > position.expirySessionIndex) {
          warnings.push(
            `${position.id}: held past expiry ${position.expiration} — forced intrinsic settlement at ${bar.timestamp}`,
          );
        }
        continue;
      }

      const adverseSpot = position.side === "put" ? bar.low : bar.high;
      const adverseCost = buybackCost(position, adverseSpot, minutesLeft, params);
      position.maxCost = Math.max(position.maxCost, adverseCost);
      const stopLevel = params.stopMultiple * position.credit;
      if (minutesLeft > 0 && adverseCost >= stopLevel) {
        const cost = Math.min(
          position.width,
          Math.max(adverseCost, stopLevel) + params.stopSlippagePct * position.credit,
        );
        closeNow(position, bar, minutesLeft, cost, "stop");
        continue;
      }

      const favourableSpot = position.side === "put" ? bar.high : bar.low;
      const favourableCost = buybackCost(position, favourableSpot, minutesLeft, params);
      position.minCost = Math.min(position.minCost, favourableCost);
      const targetLevel = params.targetProfitPct * position.credit;
      if (minutesLeft > 0 && favourableCost <= targetLevel) {
        closeNow(position, bar, minutesLeft, targetLevel, "target");
        continue;
      }

      if (sessionIndex === position.expirySessionIndex && bar.etMinutes >= closeEt) {
        closeNow(position, bar, minutesLeft, mid, "time_close");
      }
    }

    const markEquity =
      book.equity + open.reduce((a, p) => a + (p.credit - p.lastCost) * 100 * p.contracts, 0);
    if (dayOpenEquity == null) {
      dayOpenEquity = markEquity;
    }

    if (!killed && markEquity < dayOpenEquity * (1 - params.dailyDrawdownStopPct)) {
      killed = true;
      warnings.push(
        `${date}: daily drawdown stop fired at ${bar.timestamp} (mark ${markEquity.toFixed(0)} vs open ${dayOpenEquity.toFixed(0)}) — book flattened, no further entries`,
      );
      for (const position of [...open]) {
        const symbol = symbols.get(position.underlying);
        const index = symbol?.indexByDate.get(date);
        if (index == null) {
          continue;
        }
        const minutesLeft = minutesToExpiry(index, bar.etMinutes, position.expirySessionIndex);
        closeNow(position, bar, minutesLeft, position.lastCost, "kill_switch");
      }
    }

    const key = `${underlying}:${date}`;
    if (
      killed ||
      entered.has(key) ||
      bar.etMinutes < entryEt ||
      bar.etMinutes > entryEt + ENTRY_TOLERANCE_MINUTES
    ) {
      continue;
    }
    entered.add(key);

    const symbol = symbols.get(underlying);
    if (!symbol) {
      continue;
    }
    const baseIv = symbol.ivByDate.get(date);
    if (baseIv == null) {
      reject("no_realised_vol");
      continue;
    }

    let expirySessionIndex = -1;
    for (let j = sessionIndex; j < symbol.sessions.length; j += 1) {
      const dte = daysBetweenDates(date, symbol.sessions[j].date);
      if (dte >= params.minDte && dte <= params.maxDte) {
        expirySessionIndex = j;
        break;
      }
      if (dte > params.maxDte) {
        break;
      }
    }
    if (expirySessionIndex < 0) {
      reject("no_expiry_in_window");
      continue;
    }

    const expiration = symbol.sessions[expirySessionIndex].date;
    const dte = daysBetweenDates(date, expiration);
    const minutes = minutesToExpiry(sessionIndex, bar.etMinutes, expirySessionIndex);
    const t = tradingYears(minutes);
    const spot = bar.close;

    handleEntry({
      book,
      params,
      opportunity: {
        underlying,
        date,
        sessionIndex,
        bar,
        symbol,
        baseIv,
        expiration,
        expirySessionIndex,
        dte,
        minutes,
        t,
        spot,
        width,
        sides,
      },
      reject,
      rejectionLog,
      sessionsWithEntry,
    });
  }

  const lastTickFor = (underlying: string): Tick | undefined => {
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      if (timeline[i].underlying === underlying) {
        return timeline[i];
      }
    }
    return undefined;
  };
  for (const position of [...open]) {
    const last = lastTickFor(position.underlying);
    if (!last) {
      continue;
    }
    warnings.push(
      `${position.id}: still open when the data ended (expiry ${position.expiration}) — closed at the last bar, not at a real exit`,
    );
    const minutesLeft = minutesToExpiry(
      last.sessionIndex,
      last.bar.etMinutes,
      position.expirySessionIndex,
    );
    closeNow(position, last.bar, minutesLeft, position.lastCost, "coverage_end");
  }

  trades.sort((a, b) => a.exit.timestamp.localeCompare(b.exit.timestamp));

  return {
    params,
    trades,
    equityCurve,
    stats: summariseCredit(trades, params.initialEquity, equityCurve),
    sessionsScanned,
    sessionsWithEntry: sessionsWithEntry.size,
    rejections,
    rejectionLog,
    warnings,
  };
}
