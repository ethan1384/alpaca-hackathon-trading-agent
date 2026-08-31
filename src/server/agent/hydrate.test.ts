import { describe, expect, it } from "vitest";
import type { TradingPosition } from "@/domain/trading";
import { buildManagedSpreadFromLegs, pairBullPutSpreads } from "./hydrate";

const NOW = new Date("2026-08-31T15:00:00.000Z");

function leg(
  symbol: string,
  side: "long" | "short",
  qty: number,
  avgEntryPrice: number,
): TradingPosition {
  return { symbol, side, qty, avgEntryPrice };
}

describe("pairBullPutSpreads", () => {
  it("pairs a bull put spread from short + long puts", () => {
    const spreads = pairBullPutSpreads([
      leg("SPY260902P00662000", "short", 2, 0.68),
      leg("SPY260902P00657000", "long", 2, 0.15),
    ]);

    expect(spreads).toHaveLength(1);
    expect(spreads[0]).toMatchObject({
      kind: "bull_put_spread",
      shortStrike: 662,
      longStrike: 657,
      width: 5,
      contracts: 2,
      credit: 0.53,
      status: "open",
    });
    expect(spreads[0].stopBuyback).toBeCloseTo(0.53 * 3);
    expect(spreads[0].targetBuyback).toBeCloseTo(0.53 * 0.5);
  });

  it("ignores unmatched legs and equity positions", () => {
    const spreads = pairBullPutSpreads([
      leg("SPY", "long", 100, 500),
      leg("SPY260902P00662000", "short", 2, 0.68),
    ]);
    expect(spreads).toEqual([]);
  });

  it("requires matching contract counts", () => {
    const spreads = pairBullPutSpreads([
      leg("SPY260902P00662000", "short", 2, 0.68),
      leg("SPY260902P00657000", "long", 1, 0.15),
    ]);
    expect(spreads).toEqual([]);
  });
});

describe("buildManagedSpreadFromLegs", () => {
  it("rejects non-positive net credit", () => {
    const short = leg("SPY260902P00662000", "short", 1, 0.1);
    const long = leg("SPY260902P00657000", "long", 1, 0.2);
    const result = buildManagedSpreadFromLegs(
      short,
      long,
      {
        symbol: short.symbol,
        underlying: "SPY",
        expiration: "2026-09-02",
        strike: 662,
        type: "put",
      },
      {
        symbol: long.symbol,
        underlying: "SPY",
        expiration: "2026-09-02",
        strike: 657,
        type: "put",
      },
      NOW,
    );
    expect(result).toBeNull();
  });
});
