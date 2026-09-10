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
  TriangleTimeframe,
  TriangleTrade,
} from "@/domain/backtest-triangle";
import type { Bar, Timeframe } from "@/domain/types";
import { getBarsRange as defaultGetBarsRange } from "@/server/alpaca/rest";
import { withRetry } from "@/server/alpaca/retry";
import {
  optionPrice,
  strikeForDelta,
  TRADING_MINUTES_PER_SESSION,
  tradingYears,
} from "./black-scholes";
import { impliedVolFor, shiftDays } from "./engine";
import { MARKET_CLOSE_ET, MARKET_OPEN_ET, toEastern } from "./orb";
import { detectTriangleBreakouts, type Pivot, supportAt, type TriangleBreakout } from "./triangle";

/**
 * Joins the triangle signal (`triangle.ts`) to a long call structure priced with
 * Black-Scholes, and walks a portfolio through it session by session, bar by
 * bar inside each session.
 *
 * Triggers on 30-minute bars by default (`timeframe: "1Day"` keeps the first,
 * daily study); the holding horizon is swing either way — days to weeks, on a
 * 30-45 DTE option. Choices that move the result, each on the pessimistic side:
 *
 * - **Regular session only.** Alpaca's 30Min feed also returns pre-market and
 *   after-hours bars; they are dropped before detection, entry and exit, and
 *   session closes (IV, benchmark, equity marks) come from the last regular bar.
 * - **Entry at the next bar's open.** The breakout is only known at the close
 *   that makes it, so the position opens at the following regular bar's open —
 *   the next morning's 09:30 when the breakout is the 15:30 bar, gap included.
 * - **Stop at the session close by default** (`stopCheck`). The target is
 *   tested on every bar's high. On the bar where both are tested, the stop goes
 *   first: a bar does not say which extreme came first. On `1Day` every bar is
 *   the last of its session, which is the original stop-before-target order.
 * - **Risk = the full debit.** A long premium position can lose all of it; the
 *   stop usually recovers some, but sizing does not count on it.
 *
 * Time to expiry is in trading minutes through `tradingYears` — the minutes
 * left in the current session plus 390 per session still to come, on the same
 * 252-session calendar realised vol is annualised on. Never `yearsBetween` (see
 * AGENTS.md). Exchange holidays are counted as sessions.
 */

/** Calendar days of history fetched before `start`: pattern lookback + realised vol. */
const HISTORY_PAD_DAYS = 200;
/** Cap on the single `1Day` request — six and a half years of daily bars fit in one page. */
const MAX_DAILY_BARS = 10_000;
/** Regular-session minutes one bar covers. A daily bar is the whole session. */
const BAR_MINUTES: Record<TriangleTimeframe, number> = {
  "1Day": TRADING_MINUTES_PER_SESSION,
  "30Min": 30,
};
/** Bars drawn around a trade's chart: before the pattern's first touch, after the exit. */
const CHART_CONTEXT: Record<TriangleTimeframe, { before: number; after: number }> = {
  "1Day": { before: 25, after: 15 },
  "30Min": { before: 39, after: 26 },
};
/**
 * Fetching under Alpaca's data rate limit — 200 requests a minute, counted per
 * page. Alpaca pages 30-minute bars ~600 at a time whatever `limit` asks
 * (measured 2026-09-10: KO 2023, 599 bars from Jan 3 to Feb 3 per page), so
 * six years of 30-minute history for 41 symbols is ~3,200 requests. A first
 * version paced calls rather than pages: each call burst a dozen pages into
 * the limit ("too many requests" on SPY and DIA).
 *
 * - Pacing is per page, inside the data client (`getBacktestDataClient`, at
 *   most ~183 requests in any minute) — the only layer that sees every page.
 * - `30Min` history is requested in 365-day chunks (≈ 12 pages each), so a
 *   failure retries one year, not six. `1Day` stays a single call, fetching
 *   exactly what the first study did.
 * - Two symbols at a time.
 * - A 429 the client's own page retries could not absorb, or a failure with no
 *   HTTP status (what the SDK throws when the limit cuts the connection),
 *   waits the window out: until `X-RateLimit-Reset` when the error carries it,
 *   never less than 61 s. Any other retryable failure keeps the short
 *   exponential backoff.
 */
const FETCH_CONCURRENCY = 2;
const FETCH_ATTEMPTS = 4;
const FETCH_BASE_DELAY_MS = 3_000;
const RATE_LIMIT_WAIT_MS = 61_000;
/** Calendar days per 30-minute call; see above. */
const CHUNK_DAYS = 365;
/** Per-call bar cap. A year of 30-minute bars is at most 8,064 (04:00–20:00 ET). */
const CHUNK_MAX_BARS = 10_000;
/** A spread priced outside this share of its width means broken inputs, not a trade. */
const MIN_DEBIT_RATIO = 0.05;
const MAX_DEBIT_RATIO = 0.95;
const DAY_MS = 86_400_000;

export interface TriangleBacktestDeps {
  getBarsRange: (
    symbol: string,
    timeframe: Timeframe,
    start: string,
    end: string,
    maxPerSymbol?: number,
    feed?: "iex" | "sip",
  ) => Promise<Bar[]>;
  /** Retry waits, rate-limit window included. Injectable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Wall clock in epoch ms, for rate-limit resets and the bar cache. Injectable for tests. */
  now?: () => number;
  /**
   * Aborted when the HTTP client goes away. Checked before every request, so a
   * caller that timed out does not leave the run downloading for nobody.
   */
  signal?: AbortSignal;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Series already fetched by this server process, keyed by the whole request
 * (symbol, bar size, window, feed). A sensitivity grid reruns the same 41
 * symbols × 6 years once per variant, and 30-minute history is heavy — on a
 * slow link a single fetch takes most of an hour. Historical bars do not
 * change; entries still expire after `SERIES_CACHE_TTL_MS` so a window ending
 * today is refetched. Only real market data is cached, never an injected
 * source. On `globalThis` so a dev-server hot reload keeps it.
 */
interface CachedSeries {
  at: number;
  truncated: boolean;
  series: Series;
}
const SERIES_CACHE_TTL_MS = 2 * 3_600_000;
const SERIES_CACHE_MAX = 120;
const cacheHost = globalThis as { __triangleSeriesCache?: Map<string, CachedSeries> };
cacheHost.__triangleSeriesCache ??= new Map();
const seriesCache: Map<string, CachedSeries> = cacheHost.__triangleSeriesCache;

function cachedSeries(key: string, now: number): CachedSeries | undefined {
  const hit = seriesCache.get(key);
  if (hit && now - hit.at > SERIES_CACHE_TTL_MS) {
    seriesCache.delete(key);
    return undefined;
  }
  return hit;
}

function storeSeries(key: string, entry: CachedSeries): void {
  seriesCache.delete(key);
  seriesCache.set(key, entry);
  while (seriesCache.size > SERIES_CACHE_MAX) {
    const oldest = seriesCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    seriesCache.delete(oldest);
  }
}

/** `[from, to]` date ranges of at most `days` calendar days, covering `start..end` without gap or overlap. */
export function dateChunks(start: string, end: string, days: number): [string, string][] {
  const chunks: [string, string][] = [];
  let from = start;
  while (from <= end) {
    const last = shiftDays(from, days - 1);
    const to = last < end ? last : end;
    chunks.push([from, to]);
    from = shiftDays(to, 1);
  }
  return chunks;
}

/**
 * How long to wait before retrying a bars request. A 429 — or a failure with no
 * HTTP status, which is how the SDK reports a connection the limit cut — waits
 * for the rate-limit window to reset: `X-RateLimit-Reset` (surfaced by the SDK
 * as `rateLimit.reset`) or `retryAfterMs` when present, never less than 61 s,
 * never more than 5 minutes. Anything else keeps `backoffMs`.
 */
export function fetchRetryDelay(error: unknown, backoffMs: number, now: number): number {
  const e = (typeof error === "object" && error !== null ? error : {}) as {
    status?: unknown;
    retryAfterMs?: unknown;
    rateLimit?: { reset?: unknown };
  };
  const status = Number(e.status);
  if (e.status != null && Number.isFinite(status) && status !== 429) {
    return backoffMs;
  }
  let wait = RATE_LIMIT_WAIT_MS;
  const reset = e.rateLimit?.reset;
  if (reset instanceof Date && !Number.isNaN(reset.getTime())) {
    wait = Math.max(wait, reset.getTime() - now + 1_000);
  }
  if (typeof e.retryAfterMs === "number" && Number.isFinite(e.retryAfterMs)) {
    wait = Math.max(wait, e.retryAfterMs);
  }
  return Math.min(wait, 5 * RATE_LIMIT_WAIT_MS);
}

interface Series {
  underlying: string;
  /** Regular-session bars only on `30Min`, time-ordered, one per timestamp. */
  bars: Bar[];
  /** `bars[i]` as epoch milliseconds. */
  times: number[];
  /** ET session date of each bar. */
  dates: string[];
  /** ET minute each bar opens at (`MARKET_OPEN_ET` for a daily bar). */
  openMinutes: number[];
  /** Whether bar `i` is the last one this series printed in its session. */
  lastOfSession: boolean[];
  /** One close per session: the last bar's. */
  closes: { date: string; close: number }[];
}

interface OpenPosition {
  id: string;
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
  /** Next bar of `series` to process. */
  cursor: number;
  /** Last bar processed — where an end-of-data close lands. */
  lastIndex: number;
  /** Session of the last processed bar, to count sessions held. */
  lastSession: string;
}

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

/**
 * Trading minutes from `etMinutes` on session `date` to the close of the
 * `expiration` session: what is left of today's session, plus 390 for every
 * session after it up to and including expiry. At the 09:30 open that is
 * exactly `sessionsBetween × 390`; at the 16:00 close, one session less.
 */
export function minutesToExpiry(
  date: string,
  etMinutes: number,
  expiration: string,
  sessions: (from: string, to: string) => number = sessionsBetween,
): number {
  const remaining = sessions(date, expiration);
  if (remaining === 0) {
    return 0;
  }
  const leftToday = Math.min(
    TRADING_MINUTES_PER_SESSION,
    Math.max(0, MARKET_CLOSE_ET - Math.max(MARKET_OPEN_ET, etMinutes)),
  );
  return leftToday + TRADING_MINUTES_PER_SESSION * (remaining - 1);
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

/**
 * Sort, de-duplicate and — on `30Min` — keep only the regular session
 * (09:30 ≤ bar open < 16:00 ET). Session dates and closes are derived from what
 * is left, so the extended-hours bars never reach detection, pricing or marks.
 */
export function buildSeries(underlying: string, raw: Bar[], timeframe: TriangleTimeframe): Series {
  const sorted = raw
    .map((bar) => ({ bar, time: Date.parse(bar.timestamp) }))
    .sort((a, b) => a.time - b.time);

  const series: Series = {
    underlying,
    bars: [],
    times: [],
    dates: [],
    openMinutes: [],
    lastOfSession: [],
    closes: [],
  };
  for (const { bar, time } of sorted) {
    if (series.times.length > 0 && series.times[series.times.length - 1] === time) {
      continue;
    }
    let date = bar.timestamp.slice(0, 10);
    let minutes = MARKET_OPEN_ET;
    if (timeframe !== "1Day") {
      const eastern = toEastern(bar.timestamp);
      if (eastern.minutes < MARKET_OPEN_ET || eastern.minutes >= MARKET_CLOSE_ET) {
        continue;
      }
      date = eastern.date;
      minutes = eastern.minutes;
    }
    series.bars.push(bar);
    series.times.push(time);
    series.dates.push(date);
    series.openMinutes.push(minutes);
  }

  const n = series.bars.length;
  for (let i = 0; i < n; i += 1) {
    const last = i === n - 1 || series.dates[i + 1] !== series.dates[i];
    series.lastOfSession.push(last);
    if (last) {
      series.closes.push({ date: series.dates[i], close: series.bars[i].close });
    }
  }
  return series;
}

/** `fn` over `items`, at most `limit` in flight, results in input order. Stops taking work after a failure. */
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next;
      next += 1;
      try {
        results[i] = await fn(items[i]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
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

function etClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export async function runTriangleBacktest(
  params: TriangleBacktestParams,
  deps: Partial<TriangleBacktestDeps> = {},
): Promise<TriangleBacktestResult> {
  const getBarsRange = deps.getBarsRange ?? defaultGetBarsRange;
  const { timeframe } = params;
  const intraday = timeframe !== "1Day";
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

  // --- Data: one timeframe per symbol, paced, bounded and retried -----------
  const fetchStart = shiftDays(params.start, -HISTORY_PAD_DAYS);
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  // `1Day`: one call, exactly as the first study fetched. `30Min`: one page per call.
  const chunks: [string, string][] = intraday
    ? dateChunks(fetchStart, params.end, CHUNK_DAYS)
    : [[fetchStart, params.end]];
  const maxBars = intraday ? CHUNK_MAX_BARS : MAX_DAILY_BARS;
  const symbols = [...new Set([...params.underlyings, params.benchmark])];
  const cacheable = deps.getBarsRange == null;
  let fromCache = 0;
  const fetched = await mapBounded(symbols, FETCH_CONCURRENCY, async (symbol) => {
    const key = `${symbol}|${timeframe}|${fetchStart}|${params.end}|${params.feed}`;
    const cached = cacheable ? cachedSeries(key, now()) : undefined;
    if (cached) {
      fromCache += 1;
      return { symbol, truncated: cached.truncated, series: cached.series };
    }
    const raw: Bar[] = [];
    let truncated = false;
    for (const [from, to] of chunks) {
      if (deps.signal?.aborted) {
        throw new Error("Backtest aborted: the client disconnected");
      }
      let bars: Bar[];
      try {
        bars = await withRetry(
          () => getBarsRange(symbol, timeframe, from, to, maxBars, params.feed),
          {
            operation: `triangle-bars-${timeframe}`,
            attempts: FETCH_ATTEMPTS,
            baseDelayMs: FETCH_BASE_DELAY_MS,
            retryOnNoResponse: true,
            sleep,
            delayMs: (error, _attempt, backoff) => fetchRetryDelay(error, backoff, now()),
          },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${symbol}: ${timeframe} bars could not be fetched — ${message}`);
      }
      truncated ||= bars.length >= maxBars;
      for (const bar of bars) {
        raw.push(bar);
      }
    }
    // Built here so the raw payload (extended hours included) can be dropped.
    const series = buildSeries(symbol, raw, timeframe);
    if (cacheable) {
      storeSeries(key, { at: now(), truncated, series });
    }
    return { symbol, truncated, series };
  });
  if (fromCache > 0) {
    warnings.push(
      `${fromCache} of ${symbols.length} symbols served from this server's bar cache (fetched in the last 2 h) — same bars, no new request`,
    );
  }

  const seriesBySymbol = new Map<string, Series>();
  for (const { symbol, truncated, series } of fetched) {
    if (series.bars.length === 0) {
      warnings.push(`${symbol}: no ${timeframe} bars returned for ${fetchStart}..${params.end}`);
      continue;
    }
    if (truncated) {
      warnings.push(
        `${symbol}: a ${timeframe} request hit the ${maxBars}-bar cap — some history is missing`,
      );
    }
    const lastDate = series.dates[series.dates.length - 1];
    // A weekend or holiday `end` legitimately has no bar; a week's gap does not.
    if (calendarDaysBetween(lastDate, params.end) > 4) {
      warnings.push(
        `${symbol}: ${timeframe} bars stop at ${lastDate}, short of the requested end ${params.end} — the window actually tested is shorter`,
      );
    }
    seriesBySymbol.set(symbol, series);
  }

  const tradedSeries = params.underlyings
    .map((u) => seriesBySymbol.get(u))
    .filter((s): s is Series => s != null);

  const inWindow = (date: string) => date >= params.start && date <= params.end;

  // --- Layer 1: breakouts, keyed by the bar they can be entered on ----------
  const pendingByTime = new Map<
    number,
    { series: Series; breakout: TriangleBreakout; index: number }[]
  >();
  for (const series of tradedSeries) {
    const detection = detectTriangleBreakouts(
      series.bars,
      params,
      intraday ? series.openMinutes : undefined,
    );

    funnel.rejectedVolume += detection.rejectedVolume.filter((r) =>
      inWindow(series.dates[r.index]),
    ).length;

    for (const breakout of detection.breakouts) {
      if (!inWindow(series.dates[breakout.index])) {
        continue;
      }
      funnel.breakouts += 1;
      // The next regular bar: the 09:30 of the next session after a 15:30 breakout.
      const index = breakout.index + 1;
      if (index >= series.bars.length || series.dates[index] > params.end) {
        funnel.skippedData += 1;
        continue;
      }
      const time = series.times[index];
      const list = pendingByTime.get(time) ?? [];
      list.push({ series, breakout, index });
      pendingByTime.set(time, list);
    }
  }

  // --- Layer 2: the portfolio, one session at a time, one bar at a time -----
  const slotsByDate = new Map<string, Set<number>>();
  for (const series of tradedSeries) {
    series.dates.forEach((date, i) => {
      if (!inWindow(date)) {
        return;
      }
      const slots = slotsByDate.get(date) ?? new Set<number>();
      slots.add(series.times[i]);
      slotsByDate.set(date, slots);
    });
  }
  const calendar = [...slotsByDate.keys()].sort();

  const trades: TriangleTrade[] = [];
  const barsByTrade: Record<string, CompactBar[]> = {};
  const equityCurve: EquityPoint[] = [];
  const open: OpenPosition[] = [];
  let cash = params.initialEquity;
  let equity = params.initialEquity;

  const sessionsMemo = new Map<string, number>();
  const cachedSessions = (from: string, to: string) => {
    const key = `${from}|${to}`;
    let value = sessionsMemo.get(key);
    if (value == null) {
      value = sessionsBetween(from, to);
      sessionsMemo.set(key, value);
    }
    return value;
  };
  const barCloseMinute = (series: Series, index: number) =>
    Math.min(MARKET_CLOSE_ET, series.openMinutes[index] + BAR_MINUTES[timeframe]);

  const legFriction = (price: number) =>
    Math.max(params.minFrictionPerLeg, price * params.frictionPct);

  /** Model value of the structure and the friction to cross it, per share. */
  const priceStructure = (
    pos: { longStrike: number; shortStrike: number | null; iv: number },
    spot: number,
    minutesLeft: number,
  ) => {
    const t = tradingYears(minutesLeft);
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

  const stopLevelAt = (breakout: TriangleBreakout, index: number): number => {
    const base = params.stopMode === "support" ? supportAt(breakout, index) : breakout.resistance;
    return base * (1 - params.stopBufferPct);
  };

  const chartWindow = (series: Series, startIndex: number, exitIndex: number): CompactBar[] => {
    const { before, after } = CHART_CONTEXT[timeframe];
    const from = Math.max(0, startIndex - before);
    const to = Math.min(series.bars.length, exitIndex + after + 1);
    return series.bars.slice(from, to).map(toCompact);
  };

  const tryOpen = (series: Series, breakout: TriangleBreakout, index: number) => {
    if (
      open.length >= params.maxOpenPositions ||
      open.some((p) => p.series.underlying === series.underlying)
    ) {
      funnel.skippedCapacity += 1;
      return;
    }
    const bar = series.bars[index];
    const date = series.dates[index];
    const spot = bar.open;
    const label = intraday
      ? `${series.underlying} ${date} ${etClock(series.openMinutes[index])}`
      : `${series.underlying} ${date}`;

    if (spot >= breakout.target) {
      funnel.skippedStructure += 1;
      warnings.push(`${label}: opened at ${spot.toFixed(2)}, already past the target — no trade`);
      return;
    }

    const iv = impliedVolFor(series.closes, date, params.hvLookbackDays, params.ivMultiplier);
    if (iv == null) {
      funnel.skippedData += 1;
      warnings.push(
        `${label}: not enough prior session closes for realised vol — skipped rather than priced off a default IV`,
      );
      return;
    }

    const expiration = expirationFor(date, params.dteDays);
    const minutesAtOpen = minutesToExpiry(
      date,
      series.openMinutes[index],
      expiration,
      cachedSessions,
    );
    const t = tradingYears(minutesAtOpen);
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

    const { theo, friction } = priceStructure({ longStrike, shortStrike, iv }, spot, minutesAtOpen);
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
      // Two entries of one underlying cannot share a session on daily bars; on
      // intraday bars the timestamp keeps the id unique regardless.
      id: `${series.underlying}-${intraday ? bar.timestamp : date}`,
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
      cursor: index,
      lastIndex: index,
      lastSession: "",
    });
  };

  const closePosition = (
    pos: OpenPosition,
    index: number,
    spot: number,
    reason: TriangleExitReason,
  ) => {
    const { series } = pos;
    const bar = series.bars[index];
    const date = series.dates[index];
    const minutesLeft = minutesToExpiry(
      date,
      barCloseMinute(series, index),
      pos.expiration,
      cachedSessions,
    );
    const { theo, friction } = priceStructure(pos, spot, minutesLeft);
    const exitValue = Math.max(0, theo - friction);
    cash += exitValue * 100 * pos.contracts;
    const pnl = (exitValue - pos.entryDebit) * 100 * pos.contracts;

    trades.push({
      id: pos.id,
      underlying: series.underlying,
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
    barsByTrade[pos.id] = chartWindow(series, pos.breakout.startIndex, index);
    open.splice(open.indexOf(pos), 1);
  };

  /**
   * One bar of an open position: mark it, then the exits. Stop (on the
   * session's last bar, or every bar with `stopCheck: bar_close`), target and
   * take-profit are tested on every bar; the time stop, the expiry floor and
   * end-of-data only at the session's last bar.
   */
  const processBar = (pos: OpenPosition, index: number, isLastSession: boolean) => {
    const { series } = pos;
    const bar = series.bars[index];
    const date = series.dates[index];
    if (pos.lastSession !== date) {
      pos.holdingDays += 1;
      pos.lastSession = date;
    }
    pos.lastIndex = index;
    const sessionEnd = series.lastOfSession[index];

    const minutesLeft = minutesToExpiry(
      date,
      barCloseMinute(series, index),
      pos.expiration,
      cachedSessions,
    );
    const mark = priceStructure(pos, bar.close, minutesLeft).theo;
    pos.lastMark = mark;
    pos.maxFavorable = Math.max(pos.maxFavorable, mark);
    pos.maxAdverse = Math.min(pos.maxAdverse, mark);
    const target = pos.breakout.target;
    if (bar.high >= target) {
      pos.targetReached = true;
    }

    const stopArmed = params.stopCheck === "bar_close" || sessionEnd;
    if (stopArmed && bar.close < stopLevelAt(pos.breakout, index)) {
      closePosition(pos, index, bar.close, "stop");
    } else if (bar.high >= target) {
      // A gap over the target fills at the open, not back down at the level.
      closePosition(pos, index, Math.max(target, bar.open), "target");
    } else if (
      pos.width != null &&
      mark >= pos.entryDebit + params.takeProfitPctOfMax * (pos.width - pos.entryDebit)
    ) {
      closePosition(pos, index, bar.close, "take_profit");
    } else if (!sessionEnd) {
      // The remaining exits are session-level.
    } else if (pos.holdingDays >= params.maxHoldDays) {
      closePosition(pos, index, bar.close, "time_stop");
    } else if (calendarDaysBetween(date, pos.expiration) <= params.exitDteFloor) {
      closePosition(pos, index, bar.close, "dte_floor");
    } else if (isLastSession) {
      closePosition(pos, index, bar.close, "end_of_data");
    }
  };

  calendar.forEach((date, dayIndex) => {
    const isLastSession = dayIndex === calendar.length - 1;
    const closedThisSession = trades.length;
    const slots = [...(slotsByDate.get(date) ?? [])].sort((a, b) => a - b);

    for (const time of slots) {
      // 1. Entries at this bar's open. When the book cannot take them all, the
      //    loudest breakout (volume ratio) goes first — deterministic, and it
      //    is the filter the signal already trusts.
      const pending = [...(pendingByTime.get(time) ?? [])].sort(
        (a, b) =>
          b.breakout.volumeRatio - a.breakout.volumeRatio ||
          a.series.underlying.localeCompare(b.series.underlying),
      );
      for (const { series, breakout, index } of pending) {
        tryOpen(series, breakout, index);
      }

      // 2. Marks and exits at this bar's close.
      for (const pos of [...open]) {
        const index = pos.cursor;
        if (index >= pos.series.bars.length || pos.series.times[index] !== time) {
          continue;
        }
        pos.cursor += 1;
        processBar(pos, index, isLastSession);
      }
    }

    // A position whose underlying printed nothing more on the last session
    // still has to be closed, at its most recent bar.
    if (isLastSession) {
      for (const pos of [...open]) {
        closePosition(pos, pos.lastIndex, pos.series.bars[pos.lastIndex].close, "end_of_data");
      }
    }

    // 3. Mark the book to model at the session close.
    equity = cash + open.reduce((sum, pos) => sum + pos.lastMark * 100 * pos.contracts, 0);
    for (const trade of trades.slice(closedThisSession)) {
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

  return {
    params,
    trades,
    equityCurve,
    benchmarkCurve,
    stats: summariseTriangle(trades, params.initialEquity, equityCurve, benchmarkCurve),
    funnel,
    barsByTrade,
    sessionsScanned: calendar.length,
    warnings,
  };
}

/** Buy-and-hold on session closes, scaled to the starting equity, carried forward over gaps. */
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
