import { describe, expect, it } from "vitest";
import { TriangleBacktestParamsSchema } from "@/domain/backtest-triangle";
import type { Bar } from "@/domain/types";
import {
  BARS_PER_SESSION,
  intradayBars,
  intradayBreakout,
  SLOT_VOLUME,
  SLOTS,
} from "./__fixtures__/triangle-intraday";
import {
  ASCENDING,
  BASE_VOLUME,
  breakoutSeries,
  DESCENDING_LOWS,
  TWO_TOUCHES,
  V_FLOOR,
  WARMUP,
  weekdayDates,
} from "./__fixtures__/triangle-series";
import {
  detectTriangleBreakouts,
  findPivots,
  relativeVolumes,
  supportAt,
  type TriangleSignalParams,
  triangleBefore,
} from "./triangle";

/** The schema's calibrated daily signal defaults — the same numbers the engine runs on. */
const PARAMS = TriangleBacktestParamsSchema.parse({
  start: "2025-01-01",
  end: "2025-12-31",
  timeframe: "1Day",
});
/** And the 30-minute ones, which is what an omitted timeframe resolves to. */
const INTRADAY = TriangleBacktestParamsSchema.parse({ start: "2025-01-01", end: "2025-12-31" });

/** ET minute of each regular bar of an `intradayBars` series. */
const slotsOf = (bars: Bar[]) => bars.map((_, i) => SLOTS[i % BARS_PER_SESSION]);

describe("findPivots", () => {
  it("only reports a swing high once `strength` bars have printed on its right", () => {
    const { bars } = breakoutSeries([]);
    const firstTop = WARMUP.length + 5; // 90 → 110 in five steps
    const k = PARAMS.pivotStrength;

    const early = findPivots(bars.slice(0, firstTop + k), k);
    expect(early.highs.some((h) => h.index === firstTop)).toBe(false);

    const confirmed = findPivots(bars.slice(0, firstTop + k + 1), k);
    expect(confirmed.highs.some((h) => h.index === firstTop)).toBe(true);
  });
});

describe("detectTriangleBreakouts", () => {
  it("fires exactly once, on the first close through the lid", () => {
    const { bars, breakoutIndex } = breakoutSeries([114, 115]);
    const { breakouts, rejectedVolume } = detectTriangleBreakouts(bars, PARAMS);

    expect(rejectedVolume).toHaveLength(0);
    expect(breakouts).toHaveLength(1);
    const [breakout] = breakouts;
    expect(breakout.index).toBe(breakoutIndex);
    expect(breakout.close).toBe(113);
    expect(breakout.touches).toHaveLength(3);
    expect(breakout.resistance).toBeCloseTo(110.5, 6);
    expect(breakout.lows.map((l) => l.price)).toEqual([99.5, 102.5, 105.5]);
    expect(breakout.height).toBeCloseTo(11, 6);
    expect(breakout.target).toBeCloseTo(121.5, 6);
    expect(breakout.volumeRatio).toBeCloseTo(3, 6);
    expect(supportAt(breakout, breakout.index)).toBeLessThan(breakout.resistance);
  });

  it("gives the same answer on the series truncated at the breakout — no lookahead", () => {
    const { bars, breakoutIndex } = breakoutSeries([114, 115, 120, 125]);
    const full = detectTriangleBreakouts(bars, PARAMS).breakouts;
    const truncated = detectTriangleBreakouts(bars.slice(0, breakoutIndex + 1), PARAMS).breakouts;

    expect(truncated).toHaveLength(1);
    expect(truncated[0]).toEqual(full[0]);
  });

  it("rejects a breakout on ordinary volume", () => {
    const { bars, breakoutIndex } = breakoutSeries([114], { breakoutVolume: BASE_VOLUME });
    const { breakouts, rejectedVolume } = detectTriangleBreakouts(bars, PARAMS);

    expect(breakouts).toHaveLength(0);
    expect(rejectedVolume.map((r) => r.index)).toEqual([breakoutIndex]);
  });

  it("does not call descending lows a triangle", () => {
    const { bars } = breakoutSeries([114], { pattern: DESCENDING_LOWS });
    expect(detectTriangleBreakouts(bars, PARAMS).breakouts).toHaveLength(0);
  });

  it("needs strictly higher swing lows — a V under the lid is not a rising floor", () => {
    const { bars } = breakoutSeries([114], { pattern: V_FLOOR });
    expect(detectTriangleBreakouts(bars, PARAMS).breakouts).toHaveLength(0);
  });

  it("needs `minTouches` swing highs on the lid", () => {
    const { bars } = breakoutSeries([114], { pattern: TWO_TOUCHES });
    expect(detectTriangleBreakouts(bars, PARAMS).breakouts).toHaveLength(0);
    expect(detectTriangleBreakouts(bars, { ...PARAMS, minTouches: 2 }).breakouts).toHaveLength(1);
  });

  it("needs the pattern to be tall enough", () => {
    const { bars } = breakoutSeries([114]);
    expect(detectTriangleBreakouts(bars, { ...PARAMS, minHeightPct: 0.2 }).breakouts).toHaveLength(
      0,
    );
  });

  it("does not fire before the pattern has run `minPatternBars`", () => {
    const { bars } = breakoutSeries([114]);
    const span = ASCENDING.length; // first touch → breakout is shorter than the whole pattern
    expect(
      detectTriangleBreakouts(bars, { ...PARAMS, minPatternBars: span }).breakouts,
    ).toHaveLength(0);
  });
});

describe("relativeVolumes", () => {
  it("measures each bar against the same ET slot of prior sessions", () => {
    const bars = intradayBars(Array.from({ length: BARS_PER_SESSION * 4 }, () => 100));
    const bySlot = relativeVolumes(bars, 20, slotsOf(bars));
    const plain = relativeVolumes(bars, 20);
    const lastClose = bars.length - 1; // the 15:30 bar of the fourth session

    // An ordinary 15:30 bar is ordinary for its slot…
    expect(bySlot[lastClose]).toBeCloseTo(1, 10);
    // …and ~4× a trailing mean dominated by quieter midday bars.
    expect(plain[lastClose]).toBeGreaterThan(3.5);
    // The first session has no same-slot baseline yet.
    expect(bySlot.slice(0, BARS_PER_SESSION).every((r) => r === 0)).toBe(true);
  });

  it("keeps only `lookback` prior sessions per slot", () => {
    const sessions = 4;
    // A 100× opening bar in the first session, ordinary ones after.
    const bars = intradayBars(
      Array.from({ length: BARS_PER_SESSION * sessions }, () => 100),
      {
        volumes: { 0: BASE_VOLUME * SLOT_VOLUME[0] * 100 },
      },
    );
    const ratios = relativeVolumes(bars, 2, slotsOf(bars));
    const opening = (session: number) => ratios[session * BARS_PER_SESSION];

    expect(opening(2)).toBeLessThan(0.1); // the outlier is still in the two-session baseline
    expect(opening(3)).toBeCloseTo(1, 10); // and has rolled out of it
  });

  it("is the plain trailing mean without slots, as the daily detector had it", () => {
    const { bars } = breakoutSeries([114, 115]);
    const ratios = relativeVolumes(bars, 20);
    for (const j of [1, 5, 25, 40, bars.length - 1]) {
      const from = Math.max(0, j - 20);
      const mean = bars.slice(from, j).reduce((a, b) => a + b.volume, 0) / (j - from);
      expect(ratios[j]).toBe(bars[j].volume / mean);
    }
    expect(ratios[0]).toBe(0);
  });
});

describe("detectTriangleBreakouts on 30-minute bars", () => {
  it("does not confirm a 15:30 breakout on that slot's ordinary volume", () => {
    const { regular, breakoutIndex } = intradayBreakout([111], {
      slot: 12,
      breakoutVolume: BASE_VOLUME * SLOT_VOLUME[12],
    });
    const detection = detectTriangleBreakouts(regular, INTRADAY, slotsOf(regular));

    expect(detection.breakouts).toHaveLength(0);
    expect(detection.rejectedVolume.map((r) => r.index)).toEqual([breakoutIndex]);
    // A trailing mean across slots would have called the closing bar loud.
    expect(detectTriangleBreakouts(regular, INTRADAY).breakouts).toHaveLength(1);
  });

  it("confirms a 15:30 breakout on three times that slot's volume", () => {
    const { regular, breakoutIndex } = intradayBreakout([111], { slot: 12 });
    const { breakouts } = detectTriangleBreakouts(regular, INTRADAY, slotsOf(regular));

    expect(breakouts).toHaveLength(1);
    expect(breakouts[0].index).toBe(breakoutIndex);
    expect(breakouts[0].volumeRatio).toBeCloseTo(3, 10);
  });
});

/** Seeded random walk — enough pivots to exercise the sliding window. */
function noisySeries(count: number, seed: number): Bar[] {
  let state = seed;
  const rand = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const dates = weekdayDates("2012-01-02", count);
  const bars: Bar[] = [];
  let close = 100;
  for (let i = 0; i < count; i += 1) {
    const open = close;
    close = Number((open * (1 + (rand() - 0.49) * 0.03)).toFixed(2));
    bars.push({
      symbol: "SPY",
      assetClass: "stock",
      open,
      close,
      high: Math.max(open, close) * (1 + rand() * 0.01),
      low: Math.min(open, close) * (1 - rand() * 0.01),
      volume: 1_000 + Math.floor(rand() * 1_000),
      timestamp: `${dates[i]}T05:00:00Z`,
    });
  }
  return bars;
}

/** The detector as it was before the sliding window: every pivot filtered on every bar. */
function referenceBreakouts(bars: Bar[], p: TriangleSignalParams): number[] {
  const { highs } = findPivots(bars, p.pivotStrength);
  const ratios = relativeVolumes(bars, p.volumeLookbackSessions);
  const out: number[] = [];
  let cooldownUntil = -1;
  for (let j = 1; j < bars.length; j += 1) {
    if (j <= cooldownUntil) {
      continue;
    }
    const pattern = triangleBefore(bars, highs, j, p);
    if (!pattern || bars[j].close <= pattern.resistance * (1 + p.breakoutBufferPct)) {
      continue;
    }
    if (ratios[j] < p.volumeMultiple) {
      continue;
    }
    out.push(j);
    cooldownUntil = j + p.cooldownBars;
  }
  return out;
}

describe("sliding pivot window", () => {
  it("finds exactly the breakouts of a full scan, on a noisy series", () => {
    const loose = {
      minTouches: 2,
      volumeMultiple: 0,
      touchTolerancePct: 0.02,
      minHeightPct: 0.02,
      minSlopePctPerBar: 0,
    };
    for (const [params, seed] of [
      [{ ...PARAMS, ...loose }, 7],
      [{ ...INTRADAY, ...loose }, 11],
    ] as const) {
      const bars = noisySeries(3_000, seed);
      const reference = referenceBreakouts(bars, params);
      expect(reference.length).toBeGreaterThan(3);
      expect(detectTriangleBreakouts(bars, params).breakouts.map((b) => b.index)).toEqual(
        reference,
      );
    }
  });
});
