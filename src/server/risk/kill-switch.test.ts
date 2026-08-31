import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TradingAccount } from "@/domain/trading";
import {
  evaluateKillSwitch,
  getKillSwitchState,
  isHalted,
  rearmKillSwitch,
  tripKillSwitch,
} from "./kill-switch";

function account(equity: number, lastEquity = 100_000): TradingAccount {
  return {
    id: "acct",
    status: "ACTIVE",
    currency: "USD",
    cash: equity,
    equity,
    lastEquity,
    buyingPower: equity,
  };
}

function deps(equity: number, lastEquity = 100_000) {
  return {
    getTradingAccount: vi.fn(async () => account(equity, lastEquity)),
    cancelAllOrders: vi.fn(async () => [{ id: "o1", status: 200 }]),
    closeAllPositions: vi.fn(async () => [{}, {}] as unknown[]),
  };
}

describe("kill switch [O1]", () => {
  beforeEach(() => {
    rearmKillSwitch();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("stays armed inside the drawdown limit", async () => {
    const d = deps(95_000);
    const state = await evaluateKillSwitch(d);
    expect(state.tripped).toBe(false);
    expect(isHalted()).toBe(false);
    expect(d.closeAllPositions).not.toHaveBeenCalled();
    expect(state.lastReading?.drawdownPct).toBeCloseTo(0.05, 6);
  });

  it("trips and liquidates past the limit", async () => {
    const d = deps(90_000);
    const state = await evaluateKillSwitch(d);
    expect(state.tripped).toBe(true);
    expect(isHalted()).toBe(true);
    expect(d.cancelAllOrders).toHaveBeenCalledOnce();
    expect(d.closeAllPositions).toHaveBeenCalledWith(true);
    expect(state.liquidation).toEqual({ ordersCancelled: 1, positionsClosed: 2 });
  });

  it("cancels orders before closing positions — an open order can refill", async () => {
    const order: string[] = [];
    await evaluateKillSwitch({
      getTradingAccount: async () => account(90_000),
      cancelAllOrders: async () => {
        order.push("cancel");
        return [];
      },
      closeAllPositions: async () => {
        order.push("close");
        return [];
      },
    });
    expect(order).toEqual(["cancel", "close"]);
  });

  it("liquidates once, not on every subsequent cycle", async () => {
    const d = deps(90_000);
    await evaluateKillSwitch(d);
    await evaluateKillSwitch(d);
    expect(d.closeAllPositions).toHaveBeenCalledOnce();
  });

  it("stays tripped and records the failure when liquidation fails", async () => {
    const state = await evaluateKillSwitch({
      getTradingAccount: async () => account(90_000),
      cancelAllOrders: async () => {
        throw new Error("alpaca down");
      },
      closeAllPositions: async () => [],
    });
    expect(state.tripped).toBe(true);
    expect(state.liquidation?.error).toContain("alpaca down");
  });

  it("does not re-arm itself — that is the point of a switch", async () => {
    const d = deps(90_000);
    await evaluateKillSwitch(d);
    d.getTradingAccount.mockResolvedValue(account(101_000));
    await evaluateKillSwitch(d);
    expect(isHalted()).toBe(true);
    rearmKillSwitch();
    expect(isHalted()).toBe(false);
  });

  it("can be tripped manually — the drill path", async () => {
    const d = deps(100_000);
    const state = await tripKillSwitch("manual drill", d);
    expect(state.tripped).toBe(true);
    expect(state.reason).toBe("manual drill");
    expect(d.closeAllPositions).toHaveBeenCalled();
    expect(getKillSwitchState().trippedAt).toBeDefined();
  });
});
