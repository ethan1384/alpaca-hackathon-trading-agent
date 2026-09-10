import type { Bar } from "@/domain/types";

/**
 * Layer 1 of the triangle backtest: ascending-triangle breakouts, computed on
 * the underlying's bars and nothing else — daily or 30-minute, the detector
 * works in bar-index space and does not care which.
 *
 * Pure and options-free, like `orb.ts`. Whether a breakout carries on to its
 * measured-move target is a property of the tape; if it does not, no option
 * structure rescues it.
 *
 * No lookahead. A swing high is only a swing high once `pivotStrength` bars
 * have printed on its right, so at bar `j` the pattern is built from pivots
 * confirmed on or before bar `j - 1`. Feeding the detector the series truncated
 * at `j` gives the same answer for `j` as feeding it the whole series — the
 * tests hold it to that.
 */

export interface Pivot {
  index: number;
  timestamp: string;
  price: number;
}

/**
 * Swing highs and lows: a bar whose high (low) dominates `strength` bars on
 * each side. Strict on the left, loose on the right, so a flat top made of two
 * equal highs yields one pivot — the first — rather than two or none.
 */
export function findPivots(bars: Bar[], strength: number): { highs: Pivot[]; lows: Pivot[] } {
  const highs: Pivot[] = [];
  const lows: Pivot[] = [];

  for (let i = strength; i < bars.length - strength; i += 1) {
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= strength && (isHigh || isLow); k += 1) {
      if (!(bars[i].high > bars[i - k].high && bars[i].high >= bars[i + k].high)) {
        isHigh = false;
      }
      if (!(bars[i].low < bars[i - k].low && bars[i].low <= bars[i + k].low)) {
        isLow = false;
      }
    }
    if (isHigh) {
      highs.push({ index: i, timestamp: bars[i].timestamp, price: bars[i].high });
    }
    if (isLow) {
      lows.push({ index: i, timestamp: bars[i].timestamp, price: bars[i].low });
    }
  }

  return { highs, lows };
}

export interface TriangleSignalParams {
  pivotStrength: number;
  lookbackBars: number;
  minPatternBars: number;
  minTouches: number;
  touchTolerancePct: number;
  minLowPivots: number;
  minSlopePctPerBar: number;
  minHeightPct: number;
  breakoutBufferPct: number;
  volumeMultiple: number;
  /** Prior bars of the same slot in the volume baseline — prior sessions on intraday bars. */
  volumeLookbackSessions: number;
  cooldownBars: number;
}

/** A formed triangle, as seen from the bar about to test its lid. */
export interface TrianglePattern {
  resistance: number;
  /** Index of the first touch of the resistance. */
  startIndex: number;
  touches: Pivot[];
  lows: Pivot[];
  /** Floor regression in index space: `price = intercept + slope * index`. */
  supportSlope: number;
  supportIntercept: number;
  height: number;
  target: number;
}

export interface TriangleBreakout extends TrianglePattern {
  /** Index of the breakout bar — the first close through the lid. */
  index: number;
  timestamp: string;
  close: number;
  volumeRatio: number;
}

export interface RejectedBreakout {
  index: number;
  timestamp: string;
  volumeRatio: number;
}

export interface TriangleDetection {
  breakouts: TriangleBreakout[];
  /** Patterns that broke out on a close but failed the volume filter. */
  rejectedVolume: RejectedBreakout[];
}

/** The rising floor's value at `index`, extended past the last low if need be. */
export function supportAt(pattern: TrianglePattern, index: number): number {
  return pattern.supportIntercept + pattern.supportSlope * index;
}

function regression(points: Pivot[]): { slope: number; intercept: number } {
  const n = points.length;
  const meanX = points.reduce((a, p) => a + p.index, 0) / n;
  const meanY = points.reduce((a, p) => a + p.price, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sxy += (p.index - meanX) * (p.price - meanY);
    sxx += (p.index - meanX) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  return { slope, intercept: meanY - slope * meanX };
}

/**
 * Each bar's volume over the mean of the `lookback` previous bars **of the same
 * slot**. 0 when there is no baseline yet.
 *
 * `slots[i]` keys bar `i` — its ET minute on intraday bars, so the 15:30 bar is
 * measured against prior 15:30 bars rather than against a midday bar that
 * trades an eighth of it. Without `slots` every bar shares one slot and this is
 * the plain trailing mean of the previous `lookback` bars (the daily case).
 *
 * One pass, a running sum per slot: O(n). Share volumes are integers, so the
 * running sum is exact and matches a fresh sum over the window.
 */
export function relativeVolumes(
  bars: Bar[],
  lookback: number,
  slots?: readonly number[],
): number[] {
  const history = new Map<number, { volumes: number[]; head: number; sum: number }>();
  const ratios = new Array<number>(bars.length);

  for (let j = 0; j < bars.length; j += 1) {
    const key = slots?.[j] ?? 0;
    let slot = history.get(key);
    if (!slot) {
      slot = { volumes: [], head: 0, sum: 0 };
      history.set(key, slot);
    }
    const count = slot.volumes.length - slot.head;
    const mean = count > 0 ? slot.sum / count : 0;
    ratios[j] = mean > 0 ? bars[j].volume / mean : 0;

    slot.volumes.push(bars[j].volume);
    slot.sum += bars[j].volume;
    if (slot.volumes.length - slot.head > lookback) {
      slot.sum -= slot.volumes[slot.head];
      slot.head += 1;
    }
  }

  return ratios;
}

/**
 * The floor's swing lows: the lowest bar between each pair of consecutive
 * touches, then between the last touch and bar `j` (the final squeeze). One
 * low per oscillation of the pattern — not every pivot low, which let a crash
 * low between two higher ones (a V) pass as a rising floor.
 */
function swingLows(bars: Bar[], touches: Pivot[], j: number): Pivot[] {
  const bounds = [...touches.map((t) => t.index), j];
  const lows: Pivot[] = [];
  for (let s = 0; s < bounds.length - 1; s += 1) {
    let lowest = -1;
    for (let i = bounds[s] + 1; i < bounds[s + 1]; i += 1) {
      if (lowest === -1 || bars[i].low < bars[lowest].low) {
        lowest = i;
      }
    }
    if (lowest !== -1) {
      lows.push({ index: lowest, timestamp: bars[lowest].timestamp, price: bars[lowest].low });
    }
  }
  return lows;
}

/**
 * The triangle, if one is fully formed going into bar `j`, from `highs` — the
 * swing highs already restricted to the window: inside `lookbackBars` of `j`
 * and confirmed by bar `j - 1`. Bar `j` itself is never looked at, so the
 * breakout test stays the caller's.
 */
function patternFromWindow(
  bars: Bar[],
  highs: Pivot[],
  j: number,
  p: TriangleSignalParams,
): TrianglePattern | null {
  if (highs.length < p.minTouches) {
    return null;
  }
  let resistance = highs[0].price;
  for (const h of highs) {
    resistance = Math.max(resistance, h.price);
  }
  const touches = highs.filter((h) => h.price >= resistance * (1 - p.touchTolerancePct));
  if (touches.length < p.minTouches) {
    return null;
  }

  const startIndex = touches[0].index;
  if (j - startIndex < p.minPatternBars) {
    return null;
  }

  // Price must have stayed under the lid since the first touch, so that bar `j`
  // is the *first* close through it. This is also what stops a breakout that
  // keeps going from re-firing on every following bar.
  const breakoutLevel = resistance * (1 + p.breakoutBufferPct);
  const ceiling = resistance * (1 + p.touchTolerancePct);
  for (let i = startIndex; i < j; i += 1) {
    if (bars[i].close > breakoutLevel || bars[i].high > ceiling) {
      return null;
    }
  }

  // Higher lows, strictly: each swing low above the one before it.
  const lows = swingLows(bars, touches, j);
  if (lows.length < p.minLowPivots) {
    return null;
  }
  for (let i = 1; i < lows.length; i += 1) {
    if (lows[i].price <= lows[i - 1].price) {
      return null;
    }
  }
  const { slope, intercept } = regression(lows);
  const meanLow = lows.reduce((a, l) => a + l.price, 0) / lows.length;
  if (slope / meanLow < p.minSlopePctPerBar) {
    return null;
  }

  const pattern: TrianglePattern = {
    resistance,
    startIndex,
    touches,
    lows,
    supportSlope: slope,
    supportIntercept: intercept,
    // The first swing low is the lowest, since the floor only rises.
    height: resistance - lows[0].price,
    target: 0,
  };
  pattern.target = resistance + pattern.height;

  if (pattern.height / resistance < p.minHeightPct) {
    return null;
  }
  // Past the apex the floor has crossed the lid: what is left is not a triangle.
  if (supportAt(pattern, j) >= resistance) {
    return null;
  }
  return pattern;
}

/**
 * The triangle, if one is fully formed going into bar `j`. Built only from
 * swing highs confirmed by bar `j - 1` and from bars before `j`.
 */
export function triangleBefore(
  bars: Bar[],
  swingHighs: Pivot[],
  j: number,
  p: TriangleSignalParams,
): TrianglePattern | null {
  const windowStart = j - p.lookbackBars;
  const highs = swingHighs.filter(
    (pivot) => pivot.index >= windowStart && pivot.index + p.pivotStrength <= j - 1,
  );
  return patternFromWindow(bars, highs, j, p);
}

/**
 * Every ascending-triangle breakout in the series, in time order. Sequencing —
 * which ones are traded, and whether the book has room — is the engine's job.
 *
 * `slots` keys each bar's volume baseline (see `relativeVolumes`); pass the ET
 * minute of each bar on intraday series, nothing on daily ones.
 *
 * The pivot window slides with two pointers: both of its bounds only move
 * forward as `j` does, so a bar costs the pivots inside its window rather than
 * every pivot of the series — the difference between seconds and minutes at
 * ~20k thirty-minute bars per symbol.
 */
export function detectTriangleBreakouts(
  bars: Bar[],
  p: TriangleSignalParams,
  slots?: readonly number[],
): TriangleDetection {
  const { highs } = findPivots(bars, p.pivotStrength);
  const volumeRatios = relativeVolumes(bars, p.volumeLookbackSessions, slots);
  const breakouts: TriangleBreakout[] = [];
  const rejectedVolume: RejectedBreakout[] = [];
  let cooldownUntil = -1;
  // `highs[lo..hi)`: inside the lookback and confirmed by `j - 1`.
  let lo = 0;
  let hi = 0;

  for (let j = 1; j < bars.length; j += 1) {
    if (j <= cooldownUntil) {
      continue;
    }
    while (hi < highs.length && highs[hi].index + p.pivotStrength <= j - 1) {
      hi += 1;
    }
    while (lo < hi && highs[lo].index < j - p.lookbackBars) {
      lo += 1;
    }
    const pattern = patternFromWindow(bars, highs.slice(lo, hi), j, p);
    if (!pattern) {
      continue;
    }
    const bar = bars[j];
    if (bar.close <= pattern.resistance * (1 + p.breakoutBufferPct)) {
      continue;
    }

    const volumeRatio = volumeRatios[j];
    if (volumeRatio < p.volumeMultiple) {
      rejectedVolume.push({ index: j, timestamp: bar.timestamp, volumeRatio });
      continue;
    }

    breakouts.push({
      ...pattern,
      index: j,
      timestamp: bar.timestamp,
      close: bar.close,
      volumeRatio,
    });
    cooldownUntil = j + p.cooldownBars;
  }

  return { breakouts, rejectedVolume };
}
