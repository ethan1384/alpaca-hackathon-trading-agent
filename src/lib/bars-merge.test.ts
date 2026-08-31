import { describe, expect, it } from "vitest";
import type { Bar } from "@/domain/types";
import { mergeTrailingBars } from "./bars-merge";

function bar(timestamp: string, close: number): Bar {
  return {
    symbol: "AAPL",
    assetClass: "stock",
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    timestamp,
  };
}

describe("mergeTrailingBars", () => {
  it("returns live when base is empty and base when live is empty", () => {
    expect(mergeTrailingBars([], [bar("t1", 1)])).toHaveLength(1);
    expect(mergeTrailingBars([bar("t1", 1)], [])).toHaveLength(1);
  });

  it("replaces the trailing candle when a live bar shares its timestamp", () => {
    const base = [bar("2026-01-05T14:00:00Z", 10), bar("2026-01-05T14:01:00Z", 11)];
    const live = [bar("2026-01-05T14:01:00Z", 12), bar("2026-01-05T14:02:00Z", 13)];

    const merged = mergeTrailingBars(base, live);

    expect(merged.map((b) => b.close)).toEqual([10, 12, 13]);
  });

  it("ignores live bars older than the historical tail", () => {
    const base = [bar("2026-01-05T14:05:00Z", 10)];
    const live = [bar("2026-01-05T14:01:00Z", 9), bar("2026-01-05T14:02:00Z", 8)];

    expect(mergeTrailingBars(base, live)).toEqual(base);
  });
});
