import { describe, expect, it } from "vitest";
import {
  chainTypeForKind,
  describeSignal,
  expectedLegCount,
  StrategySignalSchema,
} from "./strategy";

const base = {
  strategy: "test",
  underlying: "spy",
  bias: "bullish",
  kind: "long_call",
  selection: { minDte: 7, maxDte: 45 },
  confidence: 0.7,
  reason: "breakout",
  timestamp: "2026-08-28T14:00:00Z",
} as const;

describe("StrategySignalSchema", () => {
  it("accepts an unresolved signal and uppercases the underlying", () => {
    const parsed = StrategySignalSchema.parse(base);
    expect(parsed.underlying).toBe("SPY");
    expect(parsed.maxContracts).toBe(1);
  });

  it("rejects minDte greater than maxDte", () => {
    const result = StrategySignalSchema.safeParse({
      ...base,
      selection: { minDte: 60, maxDte: 30 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence outside 0..1", () => {
    expect(StrategySignalSchema.safeParse({ ...base, confidence: 1.4 }).success).toBe(false);
  });

  it("accepts a resolved long call on the underlying", () => {
    const result = StrategySignalSchema.safeParse({
      ...base,
      resolvedLegs: [
        { symbol: "SPY260116C00500000", side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an equity leg — options mandate", () => {
    const result = StrategySignalSchema.safeParse({
      ...base,
      resolvedLegs: [{ symbol: "SPY", side: "buy", ratioQty: 1, positionIntent: "buy_to_open" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a crypto leg", () => {
    const result = StrategySignalSchema.safeParse({
      ...base,
      resolvedLegs: [
        { symbol: "BTC/USD", side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a leg on a different underlying", () => {
    const result = StrategySignalSchema.safeParse({
      ...base,
      resolvedLegs: [
        { symbol: "QQQ260116C00500000", side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a well-formed bull call spread (buy lower, sell higher)", () => {
    const result = StrategySignalSchema.safeParse({
      ...base,
      kind: "bull_call_spread",
      resolvedLegs: [
        { symbol: "SPY260116C00500000", side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
        { symbol: "SPY260116C00510000", side: "sell", ratioQty: 1, positionIntent: "sell_to_open" },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a bull call spread with the strikes/sides inverted", () => {
    const result = StrategySignalSchema.safeParse({
      ...base,
      kind: "bull_call_spread",
      resolvedLegs: [
        { symbol: "SPY260116C00500000", side: "sell", ratioQty: 1, positionIntent: "sell_to_open" },
        { symbol: "SPY260116C00510000", side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects the wrong leg count for a kind", () => {
    const result = StrategySignalSchema.safeParse({
      ...base,
      kind: "long_call",
      resolvedLegs: [
        { symbol: "SPY260116C00500000", side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
        { symbol: "SPY260116C00510000", side: "sell", ratioQty: 1, positionIntent: "sell_to_open" },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("helpers", () => {
  it("maps kind -> expected leg count", () => {
    expect(expectedLegCount("long_put")).toBe(1);
    expect(expectedLegCount("bear_put_spread")).toBe(2);
  });

  it("maps kind -> chain type", () => {
    expect(chainTypeForKind("long_call")).toBe("call");
    expect(chainTypeForKind("bear_put_spread")).toBe("put");
    expect(chainTypeForKind("long_straddle")).toBe("all");
  });

  it("describes a resolved signal", () => {
    const signal = StrategySignalSchema.parse({
      ...base,
      resolvedLegs: [
        { symbol: "SPY260116C00500000", side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
      ],
    });
    expect(describeSignal(signal)).toContain("long_call on SPY");
    expect(describeSignal(signal)).toContain("buy SPY Call 500 $");
  });
});
