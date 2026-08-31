import { describe, expect, it, vi } from "vitest";
import { StrategySignalSchema } from "@/domain/strategy";
import type { PlaceOrderInput, TradingOrder } from "@/domain/trading";
import { deriveOrderClass } from "@/domain/trading";
import { executeSignal, signalToOrder } from "./execute";

const TS = "2026-08-28T14:00:00Z";

function baseSignal(overrides: Record<string, unknown>) {
  return StrategySignalSchema.parse({
    strategy: "test",
    underlying: "SPY",
    bias: "bullish",
    kind: "long_call",
    selection: { minDte: 7, maxDte: 45 },
    confidence: 0.8,
    reason: "test",
    timestamp: TS,
    ...overrides,
  });
}

const LONG_CALL = {
  symbol: "SPY260116C00500000",
  side: "buy",
  ratioQty: 1,
  positionIntent: "buy_to_open",
} as const;

describe("signalToOrder", () => {
  it("maps a single leg to a simple option order", () => {
    const order = signalToOrder(baseSignal({ resolvedLegs: [LONG_CALL], maxContracts: 3 }));
    expect(order.symbol).toBe("SPY260116C00500000");
    expect(order.side).toBe("buy");
    expect(order.qty).toBe(3);
    expect(order.type).toBe("market");
    expect(order.positionIntent).toBe("buy_to_open");
    expect(deriveOrderClass(order)).toBe("simple");
  });

  it("uses a limit order when entryLimit is set", () => {
    const order = signalToOrder(baseSignal({ resolvedLegs: [LONG_CALL], entryLimit: 4.2 }));
    expect(order.type).toBe("limit");
    expect(order.limitPrice).toBe(4.2);
  });

  it("submits at market when orderType is forced, keeping entryLimit off the wire", () => {
    const order = signalToOrder(
      baseSignal({
        kind: "bull_put_spread",
        bias: "bullish",
        entryLimit: 1.2,
        orderType: "market",
        resolvedLegs: [
          {
            symbol: "SPY260116P00500000",
            side: "sell",
            ratioQty: 1,
            positionIntent: "sell_to_open",
          },
          { symbol: "SPY260116P00495000", side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
        ],
      }),
    );
    expect(order.type).toBe("market");
    expect(order.limitPrice).toBeUndefined();
  });

  it("negates the mleg limit for a net-credit spread on open", () => {
    const order = signalToOrder(
      baseSignal({
        kind: "bull_put_spread",
        bias: "bullish",
        entryLimit: 1.2,
        resolvedLegs: [
          {
            symbol: "SPY260116P00500000",
            side: "sell",
            ratioQty: 1,
            positionIntent: "sell_to_open",
          },
          { symbol: "SPY260116P00495000", side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
        ],
      }),
    );
    expect(order.type).toBe("limit");
    expect(order.limitPrice).toBe(-1.2);
  });

  it("keeps a positive mleg limit when buying the credit spread back", () => {
    const order = signalToOrder(
      baseSignal({
        kind: "bull_put_spread",
        bias: "bullish",
        entryLimit: 0.4,
        resolvedLegs: [
          {
            symbol: "SPY260116P00500000",
            side: "buy",
            ratioQty: 1,
            positionIntent: "buy_to_close",
          },
          {
            symbol: "SPY260116P00495000",
            side: "sell",
            ratioQty: 1,
            positionIntent: "sell_to_close",
          },
        ],
      }),
    );
    expect(order.limitPrice).toBe(0.4);
  });

  it("maps two legs to an mleg order", () => {
    const order = signalToOrder(
      baseSignal({
        kind: "bull_call_spread",
        entryLimit: 2.5,
        resolvedLegs: [
          LONG_CALL,
          {
            symbol: "SPY260116C00510000",
            side: "sell",
            ratioQty: 1,
            positionIntent: "sell_to_open",
          },
        ],
      }),
    );
    expect(order.symbol).toBeUndefined();
    expect(order.legs).toHaveLength(2);
    expect(deriveOrderClass(order)).toBe("mleg");
  });
});

describe("executeSignal", () => {
  it("resolves contracts then submits, and validates the options mandate", async () => {
    const placeOrder = vi.fn(
      async (input: PlaceOrderInput) => ({ id: "o1", ...input }) as unknown as TradingOrder,
    );
    const resolveContracts = vi.fn(async () => [LONG_CALL]);

    await executeSignal(baseSignal({ maxContracts: 2 }), { placeOrder, resolveContracts });

    expect(resolveContracts).toHaveBeenCalledOnce();
    expect(placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "SPY260116C00500000", qty: 2 }),
    );
  });

  it("skips resolution when the signal already carries legs", async () => {
    const placeOrder = vi.fn(
      async (input: PlaceOrderInput) => ({ id: "o1", ...input }) as unknown as TradingOrder,
    );
    const resolveContracts = vi.fn(async () => []);

    await executeSignal(baseSignal({ resolvedLegs: [LONG_CALL] }), {
      placeOrder,
      resolveContracts,
    });

    expect(resolveContracts).not.toHaveBeenCalled();
    expect(placeOrder).toHaveBeenCalledOnce();
  });

  it("throws when no contracts resolve", async () => {
    const placeOrder = vi.fn();
    const resolveContracts = vi.fn(async () => []);

    await expect(executeSignal(baseSignal({}), { placeOrder, resolveContracts })).rejects.toThrow(
      /no option contracts/,
    );
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it("[O5] writes a decision record on a successful non-agent execution", async () => {
    const placeOrder = vi.fn(async () => ({ id: "o9" }) as TradingOrder);
    const recordDecision = vi.fn(async (d) => ({ ...d, id: "d1", at: TS }));

    await executeSignal(baseSignal({ resolvedLegs: [LONG_CALL] }), { placeOrder, recordDecision });

    expect(recordDecision).toHaveBeenCalledOnce();
    expect(recordDecision.mock.calls[0][0]).toMatchObject({
      trigger: { kind: "execute", detail: "open" },
      outcome: { status: "submitted", orderId: "o9" },
      chosen: { legs: ["SPY260116C00500000"] },
    });
  });

  it("[O5] records a failed submission as outcome 'error' and still rethrows", async () => {
    const placeOrder = vi.fn(async () => {
      throw new Error("venue rejected");
    });
    const recordDecision = vi.fn(async (d) => ({ ...d, id: "d1", at: TS }));

    await expect(
      executeSignal(baseSignal({ resolvedLegs: [LONG_CALL] }), { placeOrder, recordDecision }),
    ).rejects.toThrow(/venue rejected/);
    expect(recordDecision.mock.calls[0][0].outcome).toMatchObject({
      status: "error",
      error: "venue rejected",
    });
  });

  it("skips the decision record when logExecution is false (the agent path)", async () => {
    const placeOrder = vi.fn(async () => ({ id: "o1" }) as TradingOrder);
    const recordDecision = vi.fn(async (d) => ({ ...d, id: "d1", at: TS }));

    await executeSignal(baseSignal({ resolvedLegs: [LONG_CALL] }), {
      placeOrder,
      recordDecision,
      logExecution: false,
    });

    expect(recordDecision).not.toHaveBeenCalled();
  });
});
