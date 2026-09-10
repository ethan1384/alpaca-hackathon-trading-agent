import { describe, expect, it } from "vitest";
import { TriangleBacktestParamsSchema } from "@/domain/backtest-triangle";
import {
  ASCENDING,
  BASE_VOLUME,
  breakoutSeries,
  DESCENDING_LOWS,
  TWO_TOUCHES,
  V_FLOOR,
  WARMUP,
} from "./__fixtures__/triangle-series";
import { detectTriangleBreakouts, findPivots, supportAt } from "./triangle";

/** The schema's calibrated signal defaults — the same numbers the engine runs on. */
const PARAMS = TriangleBacktestParamsSchema.parse({ start: "2025-01-01", end: "2025-12-31" });

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
