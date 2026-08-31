import { afterEach, describe, expect, it } from "vitest";
import type { PlaceOrderInput } from "@/domain/trading";
import {
  clearDecisionRing,
  describeOrder,
  recentDecisions,
  recordManualAction,
} from "./decision-log";

afterEach(() => clearDecisionRing());

describe("describeOrder", () => {
  it("pulls the underlying and contract count from a single option leg", () => {
    const input = {
      symbol: "SPY260116C00500000",
      side: "buy",
      type: "market",
      timeInForce: "day",
      qty: 3,
      positionIntent: "buy_to_open",
    } as PlaceOrderInput;

    expect(describeOrder(input)).toEqual({
      underlying: "SPY",
      legs: ["SPY260116C00500000"],
      contracts: 3,
    });
  });

  it("lists every leg of an mleg spread", () => {
    const input = {
      type: "limit",
      timeInForce: "day",
      qty: 1,
      limitPrice: -0.4,
      legs: [
        { symbol: "SPY260116P00500000", side: "sell", ratioQty: 1, positionIntent: "sell_to_open" },
        { symbol: "SPY260116P00495000", side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
      ],
    } as PlaceOrderInput;

    const described = describeOrder(input);
    expect(described.underlying).toBe("SPY");
    expect(described.legs).toHaveLength(2);
  });

  it("falls back to the raw symbol for a non-option (equity) order", () => {
    const input = {
      symbol: "AAPL",
      side: "buy",
      type: "market",
      timeInForce: "day",
      qty: 10,
    } as PlaceOrderInput;

    expect(describeOrder(input).underlying).toBe("AAPL");
  });
});

describe("recordManualAction", () => {
  it("lands in the decision ring with a manual trigger and the given outcome", async () => {
    await recordManualAction({
      action: "place_order",
      underlying: "SPY",
      legs: ["SPY260116C00500000"],
      contracts: 2,
      reason: "raw order via MCP place_order",
      outcome: { status: "submitted", orderId: "abc" },
      source: "mcp",
    });

    const [record] = recentDecisions(1);
    expect(record).toMatchObject({
      strategy: "manual:mcp",
      trigger: { kind: "manual", detail: "place_order" },
      outcome: { status: "submitted", orderId: "abc" },
      chosen: { legs: ["SPY260116C00500000"], contracts: 2 },
    });
  });

  it("records a failed action as an error outcome with no chosen structure", async () => {
    await recordManualAction({
      action: "close_all_positions",
      reason: "liquidate everything",
      outcome: { status: "error", error: "boom" },
      source: "rest",
    });

    const [record] = recentDecisions(1);
    expect(record.chosen).toBeNull();
    expect(record.outcome).toEqual({ status: "error", error: "boom" });
  });
});
