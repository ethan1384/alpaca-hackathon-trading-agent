import type { Bar } from "@/domain/types";

/**
 * Layer 1 of the triangle backtest: ascending-triangle breakouts, computed on
 * the underlying's daily bars and nothing else.
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
  volumeLookbackBars: number;
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

/** Volume of bar `j` over the mean of the `lookback` bars before it. 0 when there is no baseline. */
export function relativeVolume(bars: Bar[], j: number, lookback: number): number {
  const from = Math.max(0, j - lookback);
  if (from >= j) {
    return 0;
  }
  let total = 0;
  for (let i = from; i < j; i += 1) {
    total += bars[i].volume;
  }
  const mean = total / (j - from);
  return mean > 0 ? bars[j].volume / mean : 0;
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
 * The triangle, if one is fully formed going into bar `j`. Built only from
 * swing highs confirmed by bar `j - 1` and from bars before `j`; bar `j` itself
 * is never looked at, so the breakout test stays the caller's.
 */
export function triangleBefore(
  bars: Bar[],
  swingHighs: Pivot[],
  j: number,
  p: TriangleSignalParams,
): TrianglePattern | null {
  const confirmedBy = j - 1;
  const windowStart = j - p.lookbackBars;
  const highs = swingHighs.filter(
    (pivot) => pivot.index >= windowStart && pivot.index + p.pivotStrength <= confirmedBy,
  );
  if (highs.length < p.minTouches) {
    return null;
  }
  const resistance = Math.max(...highs.map((h) => h.price));
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
 * Every ascending-triangle breakout in the series, in time order. Sequencing —
 * which ones are traded, and whether the book has room — is the engine's job.
 */
export function detectTriangleBreakouts(bars: Bar[], p: TriangleSignalParams): TriangleDetection {
  const { highs } = findPivots(bars, p.pivotStrength);
  const breakouts: TriangleBreakout[] = [];
  const rejectedVolume: RejectedBreakout[] = [];
  let cooldownUntil = -1;

  for (let j = 1; j < bars.length; j += 1) {
    if (j <= cooldownUntil) {
      continue;
    }
    const pattern = triangleBefore(bars, highs, j, p);
    if (!pattern) {
      continue;
    }
    const bar = bars[j];
    if (bar.close <= pattern.resistance * (1 + p.breakoutBufferPct)) {
      continue;
    }

    const volumeRatio = relativeVolume(bars, j, p.volumeLookbackBars);
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
