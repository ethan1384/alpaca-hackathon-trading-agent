import { describe, expect, it } from "vitest";
import { createOptionBarAggregator, minuteBucket } from "./bar-aggregator";

const symbol = "AAPL260116C00150000";

function trade(price: number, size: number, timestamp: string) {
  return { symbol, price, size, timestamp };
}

describe("minuteBucket", () => {
  it("truncates to the start of the minute", () => {
    expect(minuteBucket("2026-01-05T14:32:47.512Z")).toBe("2026-01-05T14:32:00.000Z");
  });
});

describe("createOptionBarAggregator", () => {
  it("folds trades in the same minute into one candle", () => {
    const agg = createOptionBarAggregator();

    agg.push(trade(1.2, 3, "2026-01-05T14:32:01Z"));
    agg.push(trade(1.5, 2, "2026-01-05T14:32:20Z"));
    const bar = agg.push(trade(1.1, 5, "2026-01-05T14:32:59Z"));

    expect(bar).toMatchObject({
      symbol,
      assetClass: "option",
      timestamp: "2026-01-05T14:32:00.000Z",
      open: 1.2,
      high: 1.5,
      low: 1.1,
      close: 1.1,
      volume: 10,
      tradeCount: 3,
    });
  });

  it("starts a new candle when the minute rolls over", () => {
    const agg = createOptionBarAggregator();

    agg.push(trade(1.2, 3, "2026-01-05T14:32:10Z"));
    const next = agg.push(trade(1.4, 1, "2026-01-05T14:33:02Z"));

    expect(next).toMatchObject({
      timestamp: "2026-01-05T14:33:00.000Z",
      open: 1.4,
      high: 1.4,
      low: 1.4,
      close: 1.4,
      volume: 1,
    });
  });

  it("resets a symbol's running candle", () => {
    const agg = createOptionBarAggregator();
    agg.push(trade(1.2, 3, "2026-01-05T14:32:10Z"));
    agg.reset(symbol);
    const bar = agg.push(trade(9, 1, "2026-01-05T14:32:40Z"));
    expect(bar.open).toBe(9);
  });
});
