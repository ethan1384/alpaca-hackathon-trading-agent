import type { Bar } from "@/domain/types";
import { BASE_VOLUME, interpolate, weekdayDates } from "./triangle-series";

/**
 * Synthetic 30-minute series for the intraday triangle tests, laid out 13
 * regular bars per session and stamped in EDT (UTC−4), June 2025.
 *
 * The daily fixture's shape, shrunk to the size a two-to-three-session
 * triangle actually has: lid 110.1, floor lows 107.9 → 108.5 → 109.1, a
 * breakout close at 110.6, target 112.3. The daily fixture's 20% swings would
 * move session closes ~10% a day, and realised vol — hence the whole option
 * structure — with them.
 *
 * Volume follows the usual intraday U: the 15:30 bar trades 8× the midday one
 * on an ordinary day, which is what the per-slot baseline has to absorb.
 */

/** ET minute each regular 30-minute bar opens at: 09:30 … 15:30. */
export const SLOTS = Array.from({ length: 13 }, (_, i) => 570 + 30 * i);
export const BARS_PER_SESSION = SLOTS.length;
/** Ordinary volume of each slot, as a multiple of `BASE_VOLUME`. */
export const SLOT_VOLUME = [3, 2, 1.5, 1.2, 1, 1, 1, 1, 1, 1.2, 1.5, 2.5, 8];

/** High/low beyond the bar's body. */
const WICK = 0.1;

/** Ascending triangle up to (not including) the breakout bar: tops at 110, lows 108 → 108.6 → 109.2. */
export const INTRADAY_PATTERN = interpolate([106, 110, 108, 110, 108.6, 110, 109.2, 109.8], 5);

/** What the detector should read off `intradayBreakout`. */
export const INTRADAY_GEOMETRY = {
  breakoutClose: 110.6,
  /** The tops' highs: 110 + wick. */
  resistance: 110.1,
  /** Resistance minus the first floor low (108 − wick). */
  height: 2.2,
  target: 112.3,
} as const;

/** 09:30 ET in EDT is 13:30Z. */
const EDT_OFFSET_MINUTES = 240;

function stamp(date: string, etMinutes: number): string {
  const utc = etMinutes + EDT_OFFSET_MINUTES;
  const hh = String(Math.floor(utc / 60)).padStart(2, "0");
  const mm = String(utc % 60).padStart(2, "0");
  return `${date}T${hh}:${mm}:00Z`;
}

/** Pre-market and after-hours slots the 30Min feed also returns: 08:00, 08:30, 16:00, 16:30 ET. */
const EXTENDED_SLOTS = [480, 510, 960, 990];

/**
 * Regular-session bars from closes, 13 per weekday session: open = previous
 * close, high/low = the body ± a 0.1 wick, volume = the slot's ordinary volume
 * unless `volumes` overrides it by index. With `extended`, wild pre-market and
 * after-hours bars (price 200, huge volume) are mixed in — anything that lets
 * them through shows up at once.
 */
export function intradayBars(
  closes: number[],
  options: { volumes?: Record<number, number>; extended?: boolean; start?: string } = {},
): Bar[] {
  const sessions = Math.ceil(closes.length / BARS_PER_SESSION);
  const dates = weekdayDates(options.start ?? "2025-06-02", sessions);
  const regular = closes.map((close, i): Bar => {
    const open = i === 0 ? close : closes[i - 1];
    const slot = i % BARS_PER_SESSION;
    return {
      symbol: "SPY",
      assetClass: "stock",
      open,
      high: Math.max(open, close) + WICK,
      low: Math.min(open, close) - WICK,
      close,
      volume: options.volumes?.[i] ?? BASE_VOLUME * SLOT_VOLUME[slot],
      timestamp: stamp(dates[Math.floor(i / BARS_PER_SESSION)], SLOTS[slot]),
    };
  });
  if (!options.extended) {
    return regular;
  }
  const extended = dates.flatMap((date) =>
    EXTENDED_SLOTS.map(
      (minutes): Bar => ({
        symbol: "SPY",
        assetClass: "stock",
        open: 200,
        high: 250,
        low: 50,
        close: 200,
        volume: BASE_VOLUME * 100,
        timestamp: stamp(date, minutes),
      }),
    ),
  );
  return [...regular, ...extended].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** Warmup chopping 105.9/106.1, `length` bars — history for vol and the volume baseline, no pivots. */
export function intradayWarmup(length: number): number[] {
  return Array.from({ length }, (_, i) => (i % 2 === 0 ? 105.9 : 106.1));
}

/** Warmup length that puts the breakout bar on `slot` (0 = 09:30, 12 = 15:30). */
export function warmupForSlot(slot: number, minimum = 26): number {
  let length = minimum;
  while ((length + INTRADAY_PATTERN.length) % BARS_PER_SESSION !== slot) {
    length += 1;
  }
  return length;
}

/**
 * Warmup + triangle + the 110.6 breakout on `slot` (default 3 = 11:00), on
 * `breakoutVolume` (default 3× the slot's ordinary volume) + `after`.
 * `breakoutIndex` indexes the regular bars, extended hours excluded.
 */
export function intradayBreakout(
  after: number[],
  options: { slot?: number; breakoutVolume?: number; extended?: boolean } = {},
): { bars: Bar[]; regular: Bar[]; breakoutIndex: number } {
  const slot = options.slot ?? 3;
  const warmup = intradayWarmup(warmupForSlot(slot));
  const closes = [...warmup, ...INTRADAY_PATTERN, INTRADAY_GEOMETRY.breakoutClose, ...after];
  const breakoutIndex = warmup.length + INTRADAY_PATTERN.length;
  const volumes = {
    [breakoutIndex]: options.breakoutVolume ?? BASE_VOLUME * SLOT_VOLUME[slot] * 3,
  };
  return {
    bars: intradayBars(closes, { volumes, extended: options.extended }),
    regular: intradayBars(closes, { volumes }),
    breakoutIndex,
  };
}
