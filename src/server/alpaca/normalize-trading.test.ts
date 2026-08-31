import { describe, expect, it } from "vitest";
import { normalizeAccount, normalizeOrder, normalizePosition } from "./normalize-trading";

describe("normalizeOrder", () => {
  it("coerces string money fields to numbers and maps timestamps", () => {
    const order = normalizeOrder({
      id: "abc",
      clientOrderId: "cid-1",
      symbol: "AAPL",
      side: "buy",
      type: "limit",
      orderClass: "bracket",
      timeInForce: "gtc",
      status: "new",
      qty: "10",
      filledQty: "4",
      filledAvgPrice: "150.25",
      limitPrice: "151",
      createdAt: new Date("2026-01-02T00:00:00Z"),
      legs: [
        {
          id: "leg-1",
          symbol: "AAPL",
          type: "limit",
          timeInForce: "gtc",
          status: "held",
          filledQty: "0",
        },
      ],
    });

    expect(order.qty).toBe(10);
    expect(order.filledQty).toBe(4);
    expect(order.filledAvgPrice).toBe(150.25);
    expect(order.limitPrice).toBe(151);
    expect(order.createdAt).toBe("2026-01-02T00:00:00.000Z");
    expect(order.legs?.[0].id).toBe("leg-1");
  });

  it("defaults missing numeric fields", () => {
    const order = normalizeOrder({
      id: "x",
      symbol: "TSLA",
      type: "market",
      timeInForce: "day",
      status: "filled",
    });
    expect(order.filledQty).toBe(0);
    expect(order.qty).toBeUndefined();
  });
});

describe("normalizePosition", () => {
  it("infers short side from a negative qty", () => {
    const position = normalizePosition({
      symbol: "AAPL",
      qty: "-5",
      avgEntryPrice: "150",
      marketValue: "-740",
      unrealizedPl: "10",
    });
    expect(position.side).toBe("short");
    expect(position.qty).toBe(-5);
    expect(position.unrealizedPl).toBe(10);
  });
});

describe("normalizeAccount", () => {
  it("maps the core money fields", () => {
    const account = normalizeAccount({
      id: "acc",
      accountNumber: "PA123",
      status: "ACTIVE",
      currency: "USD",
      cash: "10000",
      equity: "12500.5",
      buyingPower: "25000",
      patternDayTrader: false,
    });
    expect(account.cash).toBe(10000);
    expect(account.equity).toBe(12500.5);
    expect(account.buyingPower).toBe(25000);
    expect(account.patternDayTrader).toBe(false);
  });
});
