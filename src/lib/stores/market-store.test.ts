import { beforeEach, describe, expect, it } from "vitest";
import type { Bar } from "@/domain/types";
import { useMarketStore } from "./market-store";

const SYM = "AAPL260116C00150000";

function bar(timestamp: string, close: number): Bar {
  return {
    symbol: SYM,
    assetClass: "option",
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    timestamp,
  };
}

describe("useMarketStore.applyBar", () => {
  beforeEach(() => {
    useMarketStore.getState().reset();
  });

  it("replaces the trailing candle when the timestamp matches", () => {
    const { applyBar } = useMarketStore.getState();
    applyBar(bar("2026-01-05T14:32:00.000Z", 1.2));
    applyBar(bar("2026-01-05T14:32:00.000Z", 1.6));

    const bars = useMarketStore.getState().bySymbol[SYM].bars;
    expect(bars).toHaveLength(1);
    expect(bars[0].close).toBe(1.6);
  });

  it("appends when the timestamp advances", () => {
    const { applyBar } = useMarketStore.getState();
    applyBar(bar("2026-01-05T14:32:00.000Z", 1.2));
    applyBar(bar("2026-01-05T14:33:00.000Z", 1.4));

    const bars = useMarketStore.getState().bySymbol[SYM].bars;
    expect(bars).toHaveLength(2);
    expect(bars.map((b) => b.close)).toEqual([1.2, 1.4]);
  });
});
