import { describe, expect, it, vi } from "vitest";
import type { TradingPosition } from "@/domain/trading";
import { reconcilePositions } from "./reconcile";

function position(symbol: string, qty: number, side: "long" | "short" = "long"): TradingPosition {
  return { symbol, side, qty: Math.abs(qty), avgEntryPrice: 5 };
}

const listing = (positions: TradingPosition[]) => ({ listPositions: vi.fn(async () => positions) });

describe("reconcilePositions [O6]", () => {
  it("reports in-sync when both sides agree", async () => {
    const report = await reconcilePositions(
      { A260902C00500000: 2 },
      listing([position("A260902C00500000", 2)]),
    );
    expect(report.inSync).toBe(true);
    expect(report.matchedCount).toBe(1);
  });

  it("flags a position the account holds but the agent does not know about", async () => {
    const report = await reconcilePositions({}, listing([position("A260902C00500000", 1)]));
    expect(report.inSync).toBe(false);
    expect(report.untracked).toEqual([
      { symbol: "A260902C00500000", expectedQty: 0, actualQty: 1 },
    ]);
  });

  it("flags a position that vanished behind the agent's back", async () => {
    const report = await reconcilePositions({ A260902C00500000: 1 }, listing([]));
    expect(report.missing).toEqual([{ symbol: "A260902C00500000", expectedQty: 1, actualQty: 0 }]);
  });

  it("flags a size mismatch — a partial fill or partial close", async () => {
    const report = await reconcilePositions(
      { A260902C00500000: 3 },
      listing([position("A260902C00500000", 1)]),
    );
    expect(report.mismatched).toEqual([
      { symbol: "A260902C00500000", expectedQty: 3, actualQty: 1 },
    ]);
  });

  it("signs short positions, so a long/short flip is a mismatch not a match", async () => {
    const report = await reconcilePositions(
      { A260902C00500000: 2 },
      listing([position("A260902C00500000", 2, "short")]),
    );
    expect(report.mismatched[0].actualQty).toBe(-2);
  });

  it("reports every open position as untracked on a cold start", async () => {
    const report = await reconcilePositions(
      new Map(),
      listing([position("A260902C00500000", 1), position("B260902P00400000", 1)]),
    );
    expect(report.untracked).toHaveLength(2);
    expect(report.inSync).toBe(false);
  });
});
