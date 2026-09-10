import type { Bar } from "@/domain/types";

/**
 * Synthetic daily series for the triangle tests: a textbook ascending triangle
 * (lid at 110, floor lows 100 → 103 → 106) that breaks out at 113 on triple
 * volume. Everything is built from closes so each test can bolt its own
 * aftermath onto the breakout.
 */

export const BASE_VOLUME = 1_000;

/** `count` consecutive weekdays starting at `from`. */
export function weekdayDates(from: string, count: number): string[] {
  const dates: string[] = [];
  const day = new Date(`${from}T00:00:00Z`);
  while (dates.length < count) {
    const weekday = day.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      dates.push(day.toISOString().slice(0, 10));
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return dates;
}

/** Straight legs between `points`, `steps` bars per leg, first point included. */
export function interpolate(points: number[], steps: number): number[] {
  const out = [points[0]];
  for (let leg = 1; leg < points.length; leg += 1) {
    const from = points[leg - 1];
    const to = points[leg];
    for (let s = 1; s <= steps; s += 1) {
      out.push(Number((from + ((to - from) * s) / steps).toFixed(4)));
    }
  }
  return out;
}

/** 30 bars chopping 89/91 — history for realised vol and the volume baseline, no pivots. */
export const WARMUP = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 89 : 91));

/** Ascending triangle up to (not including) the breakout bar. */
export const ASCENDING = interpolate([90, 110, 100, 110, 103, 110, 106, 109], 5);
export const DESCENDING_LOWS = interpolate([90, 110, 106, 110, 103, 110, 100, 109], 5);
export const TWO_TOUCHES = interpolate([90, 110, 100, 110, 104, 108, 105, 109], 5);
/** A crash low between two higher ones: the regression still slopes up, the floor does not rise. */
export const V_FLOOR = interpolate([90, 110, 100, 110, 96, 110, 106, 109], 5);

/**
 * Bars from closes: open = previous close, high/low = the body ±0.5. `volumes`
 * overrides the flat baseline by index.
 */
export function toBars(
  closes: number[],
  options: { volumes?: Record<number, number>; start?: string; symbol?: string } = {},
): Bar[] {
  const dates = weekdayDates(options.start ?? "2025-01-06", closes.length);
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return {
      symbol: options.symbol ?? "SPY",
      assetClass: "stock" as const,
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: options.volumes?.[i] ?? BASE_VOLUME,
      timestamp: `${dates[i]}T05:00:00Z`,
    };
  });
}

/** Warmup + pattern + a 113 breakout on triple volume + `after`. Returns the breakout index too. */
export function breakoutSeries(
  after: number[],
  options: { pattern?: number[]; breakoutVolume?: number } = {},
): { bars: Bar[]; breakoutIndex: number } {
  const pattern = options.pattern ?? ASCENDING;
  const closes = [...WARMUP, ...pattern, 113, ...after];
  const breakoutIndex = WARMUP.length + pattern.length;
  return {
    bars: toBars(closes, {
      volumes: { [breakoutIndex]: options.breakoutVolume ?? BASE_VOLUME * 3 },
    }),
    breakoutIndex,
  };
}
