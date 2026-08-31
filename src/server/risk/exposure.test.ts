import { describe, expect, it } from "vitest";
import { StrategySignalSchema } from "@/domain/strategy";
import type { OptionQuoteRow } from "@/domain/types";
import { buildOptionSymbol } from "@/domain/types";
import { priceCandidate } from "./exposure";

const EXP = "2026-09-02";
const put = (strike: number) =>
  buildOptionSymbol({ underlying: "SPY", expiration: EXP, type: "put", strike });

function snapshotDeps(rows: Record<string, Partial<OptionQuoteRow>>) {
  return {
    getOptionSnapshots: async (symbols: string[]) => {
      const map = new Map<string, OptionQuoteRow>();
      for (const s of symbols) {
        if (rows[s]) {
          map.set(s, { symbol: s, greeks: {}, ...rows[s] } as OptionQuoteRow);
        }
      }
      return map;
    },
    getSpot: async () => 500,
  };
}

describe("priceCandidate — credit spread max loss", () => {
  it("reports (width - credit) x 100 x contracts, not the credit", async () => {
    const signal = StrategySignalSchema.parse({
      strategy: "test",
      underlying: "SPY",
      bias: "bullish",
      kind: "bull_put_spread",
      selection: { minDte: 1, maxDte: 2 },
      confidence: 0.6,
      reason: "test",
      timestamp: "2026-09-01T14:00:00Z",
      maxContracts: 3,
      entryLimit: 1.2,
      resolvedLegs: [
        { symbol: put(500), side: "sell", ratioQty: 1, positionIntent: "sell_to_open" },
        { symbol: put(495), side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
      ],
    });

    const candidate = await priceCandidate(
      signal,
      signal.resolvedLegs ?? [],
      snapshotDeps({
        [put(500)]: { greeks: { delta: -0.18, vega: 0.05 } },
        [put(495)]: { greeks: { delta: -0.1, vega: 0.04 } },
      }),
    );

    // width 5, credit 1.2 -> max loss 3.8 per spread -> 3.8 * 100 * 3
    expect(candidate.riskAmount).toBeCloseTo(3.8 * 100 * 3);
  });

  it("returns null when the credit exceeds the width (implausible)", async () => {
    const signal = StrategySignalSchema.parse({
      strategy: "test",
      underlying: "SPY",
      bias: "bullish",
      kind: "bull_put_spread",
      selection: { minDte: 1, maxDte: 2 },
      confidence: 0.6,
      reason: "test",
      timestamp: "2026-09-01T14:00:00Z",
      maxContracts: 1,
      entryLimit: 6,
      resolvedLegs: [
        { symbol: put(500), side: "sell", ratioQty: 1, positionIntent: "sell_to_open" },
        { symbol: put(495), side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
      ],
    });

    const candidate = await priceCandidate(signal, signal.resolvedLegs ?? [], snapshotDeps({}));
    expect(candidate.riskAmount).toBeNull();
  });

  it("keeps the debit rule for a long call", async () => {
    const signal = StrategySignalSchema.parse({
      strategy: "test",
      underlying: "SPY",
      bias: "bullish",
      kind: "long_call",
      selection: { minDte: 7, maxDte: 30 },
      confidence: 0.6,
      reason: "test",
      timestamp: "2026-09-01T14:00:00Z",
      maxContracts: 2,
      entryLimit: 4,
      resolvedLegs: [
        {
          symbol: buildOptionSymbol({
            underlying: "SPY",
            expiration: EXP,
            type: "call",
            strike: 505,
          }),
          side: "buy",
          ratioQty: 1,
          positionIntent: "buy_to_open",
        },
      ],
    });

    const candidate = await priceCandidate(signal, signal.resolvedLegs ?? [], snapshotDeps({}));
    expect(candidate.riskAmount).toBeCloseTo(4 * 100 * 2);
  });
});
