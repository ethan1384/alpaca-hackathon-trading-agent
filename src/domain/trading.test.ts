import { describe, expect, it } from "vitest";
import {
  ClosePositionSchema,
  deriveOrderClass,
  ListOrdersQuerySchema,
  PlaceOrderSchema,
  ReplaceOrderSchema,
} from "./trading";

describe("PlaceOrderSchema", () => {
  it("accepts a market order with qty and uppercases the symbol", () => {
    const parsed = PlaceOrderSchema.parse({ symbol: "aapl", side: "buy", qty: 10 });
    expect(parsed.symbol).toBe("AAPL");
    expect(parsed.type).toBe("market");
    expect(parsed.timeInForce).toBe("day");
  });

  it("rejects when neither qty nor notional is given", () => {
    const result = PlaceOrderSchema.safeParse({ symbol: "AAPL", side: "buy" });
    expect(result.success).toBe(false);
  });

  it("rejects qty and notional together", () => {
    const result = PlaceOrderSchema.safeParse({
      symbol: "AAPL",
      side: "buy",
      qty: 1,
      notional: 100,
    });
    expect(result.success).toBe(false);
  });

  it("requires limitPrice for a limit order", () => {
    expect(
      PlaceOrderSchema.safeParse({ symbol: "AAPL", side: "buy", type: "limit", qty: 1 }).success,
    ).toBe(false);
    expect(
      PlaceOrderSchema.safeParse({
        symbol: "AAPL",
        side: "buy",
        type: "limit",
        qty: 1,
        limitPrice: 100,
      }).success,
    ).toBe(true);
  });

  it("requires stopPrice for a stop order", () => {
    expect(
      PlaceOrderSchema.safeParse({ symbol: "AAPL", side: "sell", type: "stop", qty: 1 }).success,
    ).toBe(false);
  });

  it("requires a trail value for a trailing stop and rejects both", () => {
    expect(
      PlaceOrderSchema.safeParse({ symbol: "AAPL", side: "sell", type: "trailing_stop", qty: 1 })
        .success,
    ).toBe(false);
    expect(
      PlaceOrderSchema.safeParse({
        symbol: "AAPL",
        side: "sell",
        type: "trailing_stop",
        qty: 1,
        trailPrice: 1,
        trailPercent: 2,
      }).success,
    ).toBe(false);
  });

  it("rejects a bracket order sized by notional", () => {
    const result = PlaceOrderSchema.safeParse({
      symbol: "AAPL",
      side: "buy",
      notional: 500,
      takeProfit: { limitPrice: 210 },
      stopLoss: { stopPrice: 190 },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a multi-leg option order and derives mleg", () => {
    const parsed = PlaceOrderSchema.parse({
      type: "limit",
      qty: 1,
      limitPrice: 2.5,
      legs: [
        { symbol: "spy260116c00500000", side: "buy", positionIntent: "buy_to_open" },
        { symbol: "spy260116c00510000", side: "sell", positionIntent: "sell_to_open" },
      ],
    });
    expect(parsed.legs?.[0].symbol).toBe("SPY260116C00500000");
    expect(deriveOrderClass(parsed)).toBe("mleg");
  });

  it("rejects multi-leg with notional", () => {
    const result = PlaceOrderSchema.safeParse({
      type: "market",
      notional: 500,
      legs: [
        { symbol: "SPY260116C00500000", side: "buy", positionIntent: "buy_to_open" },
        { symbol: "SPY260116C00510000", side: "sell", positionIntent: "sell_to_open" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a multi-leg with a non-option leg", () => {
    const result = PlaceOrderSchema.safeParse({
      type: "market",
      qty: 1,
      legs: [
        { symbol: "SPY", side: "buy", positionIntent: "buy_to_open" },
        { symbol: "SPY260116C00510000", side: "sell", positionIntent: "sell_to_open" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects legs that span two underlyings", () => {
    const result = PlaceOrderSchema.safeParse({
      type: "market",
      qty: 1,
      legs: [
        { symbol: "SPY260116C00500000", side: "buy", positionIntent: "buy_to_open" },
        { symbol: "QQQ260116C00510000", side: "sell", positionIntent: "sell_to_open" },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe("PlaceOrderSchema — trailing stops on options", () => {
  const trailing = { side: "buy", type: "trailing_stop", qty: 1, trailPercent: 5 } as const;

  it("rejects a trailing stop on an OCC contract", () => {
    const parsed = PlaceOrderSchema.safeParse({ ...trailing, symbol: "SPY260902C00500000" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.message).join(" ")).toMatch(/equities only/);
  });

  it("still allows a trailing stop on an equity", () => {
    expect(PlaceOrderSchema.safeParse({ ...trailing, symbol: "SPY" }).success).toBe(true);
  });
});

describe("deriveOrderClass", () => {
  const base = { symbol: "AAPL", side: "buy", type: "market", timeInForce: "day", qty: 1 } as const;

  it("is simple with no legs", () => {
    expect(deriveOrderClass({ ...base })).toBe("simple");
  });

  it("is bracket with both legs", () => {
    expect(
      deriveOrderClass({
        ...base,
        takeProfit: { limitPrice: 210 },
        stopLoss: { stopPrice: 190 },
      }),
    ).toBe("bracket");
  });

  it("is oto with one leg", () => {
    expect(deriveOrderClass({ ...base, stopLoss: { stopPrice: 190 } })).toBe("oto");
  });

  it("honours an explicit orderClass", () => {
    expect(
      deriveOrderClass({
        ...base,
        orderClass: "oco",
        takeProfit: { limitPrice: 210 },
        stopLoss: { stopPrice: 190 },
      }),
    ).toBe("oco");
  });
});

describe("ReplaceOrderSchema", () => {
  it("requires at least one field", () => {
    expect(ReplaceOrderSchema.safeParse({}).success).toBe(false);
    expect(ReplaceOrderSchema.safeParse({ limitPrice: 123 }).success).toBe(true);
  });
});

describe("ListOrdersQuerySchema", () => {
  it("defaults status to open and splits symbols", () => {
    const parsed = ListOrdersQuerySchema.parse({ symbols: "aapl, tsla" });
    expect(parsed.status).toBe("open");
    expect(parsed.symbols).toEqual(["AAPL", "TSLA"]);
  });
});

describe("ClosePositionSchema", () => {
  it("rejects qty and percentage together", () => {
    expect(ClosePositionSchema.safeParse({ qty: 1, percentage: 50 }).success).toBe(false);
    expect(ClosePositionSchema.safeParse({ percentage: 50 }).success).toBe(true);
  });
});
