import { describe, expect, it } from "vitest";
import {
  chainTypeForKind,
  isCreditSpreadKind,
  type OptionOrderLeg,
  StrategySignalSchema,
} from "./strategy";
import { buildOptionSymbol } from "./types";

const EXP = "2026-09-02";
const put = (strike: number) =>
  buildOptionSymbol({ underlying: "SPY", expiration: EXP, type: "put", strike });
const call = (strike: number) =>
  buildOptionSymbol({ underlying: "SPY", expiration: EXP, type: "call", strike });

function signal(kind: string, legs: OptionOrderLeg[]) {
  return StrategySignalSchema.safeParse({
    strategy: "test",
    underlying: "SPY",
    bias: kind.startsWith("bull") ? "bullish" : "bearish",
    kind,
    selection: { minDte: 1, maxDte: 2, spreadWidth: 5 },
    resolvedLegs: legs,
    confidence: 0.6,
    reason: "test",
    timestamp: "2026-09-01T14:00:00Z",
  });
}

describe("credit spread kinds", () => {
  it("classifies the credit kinds", () => {
    expect(isCreditSpreadKind("bull_put_spread")).toBe(true);
    expect(isCreditSpreadKind("bear_call_spread")).toBe(true);
    expect(isCreditSpreadKind("bull_call_spread")).toBe(false);
    expect(isCreditSpreadKind("long_put")).toBe(false);
  });

  it("routes the chain query to the right option type", () => {
    expect(chainTypeForKind("bull_put_spread")).toBe("put");
    expect(chainTypeForKind("bear_call_spread")).toBe("call");
  });
});

describe("bull_put_spread leg shape (opening)", () => {
  it("accepts sell higher put + buy lower put", () => {
    const r = signal("bull_put_spread", [
      { symbol: put(500), side: "sell", ratioQty: 1, positionIntent: "sell_to_open" },
      { symbol: put(495), side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
    ]);
    expect(r.success).toBe(true);
  });

  it("rejects buying the higher put (that would be a debit spread)", () => {
    const r = signal("bull_put_spread", [
      { symbol: put(500), side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
      { symbol: put(495), side: "sell", ratioQty: 1, positionIntent: "sell_to_open" },
    ]);
    expect(r.success).toBe(false);
  });

  it("rejects calls", () => {
    const r = signal("bull_put_spread", [
      { symbol: call(500), side: "sell", ratioQty: 1, positionIntent: "sell_to_open" },
      { symbol: call(495), side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
    ]);
    expect(r.success).toBe(false);
  });

  it("rejects a single leg", () => {
    const r = signal("bull_put_spread", [
      { symbol: put(500), side: "sell", ratioQty: 1, positionIntent: "sell_to_open" },
    ]);
    expect(r.success).toBe(false);
  });
});

describe("bear_call_spread leg shape (opening)", () => {
  it("accepts sell lower call + buy higher call", () => {
    const r = signal("bear_call_spread", [
      { symbol: call(500), side: "sell", ratioQty: 1, positionIntent: "sell_to_open" },
      { symbol: call(505), side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
    ]);
    expect(r.success).toBe(true);
  });

  it("rejects selling the higher call", () => {
    const r = signal("bear_call_spread", [
      { symbol: call(500), side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
      { symbol: call(505), side: "sell", ratioQty: 1, positionIntent: "sell_to_open" },
    ]);
    expect(r.success).toBe(false);
  });
});

describe("closing legs short-circuit the structural check", () => {
  it("accepts a bull_put_spread close with reversed sides", () => {
    const r = signal("bull_put_spread", [
      { symbol: put(500), side: "buy", ratioQty: 1, positionIntent: "buy_to_close" },
      { symbol: put(495), side: "sell", ratioQty: 1, positionIntent: "sell_to_close" },
    ]);
    expect(r.success).toBe(true);
  });

  it("still enforces the underlying and leg count on a close", () => {
    const r = signal("bull_put_spread", [
      { symbol: put(500), side: "buy", ratioQty: 1, positionIntent: "buy_to_close" },
    ]);
    expect(r.success).toBe(false);
  });
});
