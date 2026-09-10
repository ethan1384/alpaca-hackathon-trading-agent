import { describe, expect, it } from "vitest";
import {
  type TriangleBacktestParamsInput,
  TriangleBacktestParamsSchema,
} from "@/domain/backtest-triangle";
import type { Bar } from "@/domain/types";
import { breakoutSeries, interpolate } from "./__fixtures__/triangle-series";
import {
  autoStrikeStep,
  expirationFor,
  runTriangleBacktest,
  sessionsBetween,
} from "./triangle-engine";

function run(bars: Bar[], overrides: Partial<TriangleBacktestParamsInput> = {}) {
  const params = TriangleBacktestParamsSchema.parse({
    underlyings: ["SPY"],
    benchmark: "SPY",
    start: bars[0].timestamp.slice(0, 10),
    end: bars[bars.length - 1].timestamp.slice(0, 10),
    // Disabled unless a test wants it, so the target and the stop are what fire.
    takeProfitPctOfMax: 1,
    ...overrides,
  });
  return runTriangleBacktest(params, { getBarsRange: async () => bars });
}

const flat = (price: number, count: number) => Array.from({ length: count }, () => price);

describe("calendar helpers", () => {
  it("counts weekday sessions inclusively", () => {
    expect(sessionsBetween("2025-01-06", "2025-01-10")).toBe(5); // Mon → Fri
    expect(sessionsBetween("2025-01-10", "2025-01-13")).toBe(2); // Fri → Mon
  });

  it("expires on the first Friday on or after entry + dteDays", () => {
    expect(expirationFor("2025-01-06", 35)).toBe("2025-02-14");
    expect(expirationFor("2025-01-03", 7)).toBe("2025-01-10");
  });

  it("snaps the strike grid to listed increments", () => {
    expect(autoStrikeStep(40)).toBe(0.5);
    expect(autoStrikeStep(230)).toBe(1);
    expect(autoStrikeStep(650)).toBe(2.5);
  });
});

describe("runTriangleBacktest", () => {
  it("enters at the next session's open and wins when the measured move is reached", async () => {
    const { bars, breakoutIndex } = breakoutSeries([
      ...interpolate([113, 123], 5).slice(1),
      ...flat(123, 5),
    ]);
    const result = await run(bars);

    expect(result.trades).toHaveLength(1);
    const [trade] = result.trades;
    expect(trade.entryTimestamp).toBe(bars[breakoutIndex + 1].timestamp);
    expect(trade.entrySpot).toBe(bars[breakoutIndex + 1].open);
    expect(trade.exitReason).toBe("target");
    expect(trade.exitSpot).toBeCloseTo(121.5, 6);
    expect(trade.targetReached).toBe(true);
    expect(trade.structure).toBe("bull_call_spread");
    expect(trade.shortStrike).toBeGreaterThan(trade.longStrike);
    expect(trade.pnl).toBeGreaterThan(0);
    expect(result.funnel.taken).toBe(1);
  });

  it("stops out when price closes back under the old lid, and loses", async () => {
    const { bars } = breakoutSeries([...interpolate([113, 105], 4).slice(1), ...flat(105, 5)]);
    const result = await run(bars);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe("stop");
    expect(result.trades[0].exitSpot).toBeLessThan(110.5 * 0.98);
    expect(result.trades[0].pnl).toBeLessThan(0);
  });

  it("closes on the time stop after `maxHoldDays` sessions", async () => {
    const { bars } = breakoutSeries(flat(114, 20));
    const result = await run(bars, { maxHoldDays: 5 });

    expect(result.trades[0].exitReason).toBe("time_stop");
    expect(result.trades[0].holdingDays).toBe(5);
  });

  it("refuses a trade one contract of which would exceed the risk budget", async () => {
    const { bars } = breakoutSeries(flat(114, 10));
    const result = await run(bars, { riskPerTradePct: 0.0001 });

    expect(result.trades).toHaveLength(0);
    expect(result.funnel.breakouts).toBe(1);
    expect(result.funnel.skippedSizing).toBe(1);
  });

  it("respects the book's position cap across underlyings", async () => {
    const { bars } = breakoutSeries(flat(114, 10));
    const result = await run(bars, { underlyings: ["AAA", "BBB"], maxOpenPositions: 1 });

    expect(result.funnel.breakouts).toBe(2);
    expect(result.trades).toHaveLength(1);
    expect(result.funnel.skippedCapacity).toBe(1);
  });

  it("prices a naked long call when asked", async () => {
    const { bars } = breakoutSeries([...interpolate([113, 123], 5).slice(1), ...flat(123, 5)]);
    const result = await run(bars, { structure: "long_call" });

    expect(result.trades[0].structure).toBe("long_call");
    expect(result.trades[0].shortStrike).toBeNull();
    expect(result.trades[0].pnl).toBeGreaterThan(0);
  });

  it("marks one equity point per session and reconciles to the trades' P&L", async () => {
    const { bars } = breakoutSeries([...interpolate([113, 105], 4).slice(1), ...flat(105, 5)]);
    const result = await run(bars);
    const totalPnl = result.trades.reduce((a, t) => a + t.pnl, 0);

    expect(result.equityCurve).toHaveLength(bars.length);
    expect(result.sessionsScanned).toBe(bars.length);
    expect(result.stats.finalEquity).toBeCloseTo(100_000 + totalPnl, 6);
    expect(result.stats.totalPnl).toBeCloseTo(totalPnl, 6);
    expect(result.benchmarkCurve).toHaveLength(bars.length);
    expect(result.barsByUnderlying.SPY).toHaveLength(bars.length);
  });

  it("closes whatever is still open on the last session", async () => {
    const { bars } = breakoutSeries(flat(114, 3));
    const result = await run(bars);

    expect(result.trades[0].exitReason).toBe("end_of_data");
    expect(result.equityCurve.at(-1)?.equity).toBeCloseTo(result.stats.finalEquity, 6);
  });
});
