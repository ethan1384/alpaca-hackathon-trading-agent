import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/config/env";
import type { DecisionDraft, DecisionRecord } from "@/domain/decision";
import type { StrategySignal } from "@/domain/strategy";
import type { TradingAccount, TradingOrder, TradingPosition } from "@/domain/trading";
import type { MarketClock } from "@/domain/types";
import { buildOptionSymbol, type OptionQuoteRow } from "@/domain/types";
import type { LlmClient } from "@/server/llm";
import { rearmKillSwitch } from "@/server/risk";
import { __resetAgentStateForTests, loadAgentState, mutateAgentState } from "./positions-store";
import { type RunCycleDeps, runAgentCycle } from "./run-cycle";

const EXP = "2026-09-02";
const SHORT = buildOptionSymbol({ underlying: "SPY", expiration: EXP, type: "put", strike: 500 });
const LONG = buildOptionSymbol({ underlying: "SPY", expiration: EXP, type: "put", strike: 495 });
const IN_WINDOW = new Date("2026-09-01T14:30:00Z"); // 10:30 EDT, scoring window
const ORIGINAL_ENV = { ...process.env };

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "run-cycle-"));
  process.env = {
    ...ORIGINAL_ENV,
    ALPACA_API_KEY: "k",
    ALPACA_API_SECRET: "s",
    AGENT_LOG_DIR: dir,
  };
  resetEnvCache();
  __resetAgentStateForTests();
  rearmKillSwitch();
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  resetEnvCache();
  __resetAgentStateForTests();
  rearmKillSwitch();
  await rm(dir, { recursive: true, force: true });
});

function chainRow(
  symbol: string,
  strike: number,
  over: Partial<OptionQuoteRow> = {},
): OptionQuoteRow {
  return {
    symbol,
    underlying: "SPY",
    expiration: EXP,
    type: "put",
    strike,
    bid: strike === 500 ? 1.3 : 0.45,
    ask: strike === 500 ? 1.4 : 0.55,
    mark: strike === 500 ? 1.35 : 0.5,
    openInterest: 5000,
    impliedVolatility: 0.18,
    greeks: { delta: strike === 500 ? -0.18 : -0.1, vega: 0.05 },
    updatedAt: IN_WINDOW.toISOString(),
    ...over,
  } as OptionQuoteRow;
}

/** Fresh (non-stale) two-leg snapshot map keyed to `now`, with explicit mids. */
function manageSnapshots(
  now: Date,
  shortBidAsk: [number, number],
  longBidAsk: [number, number],
  expiration = EXP,
) {
  return async (symbols: string[]) =>
    new Map(
      symbols
        .filter((s) => s === SHORT || s === LONG)
        .map((s) => {
          const [bid, ask] = s === SHORT ? shortBidAsk : longBidAsk;
          return [
            s,
            chainRow(s, s === SHORT ? 500 : 495, {
              bid,
              ask,
              mark: (bid + ask) / 2,
              expiration,
              updatedAt: now.toISOString(),
            }),
          ];
        }),
    );
}

function fakeLlm(reply: string | Error): LlmClient {
  return {
    model: "fake-qwen",
    complete: vi.fn(async () => {
      if (reply instanceof Error) throw reply;
      return {
        content: reply,
        model: "fake-qwen",
        usage: { inputTokens: 10, outputTokens: 4 },
        latencyMs: 3,
      };
    }),
  };
}

const ACCOUNT: TradingAccount = {
  accountNumber: "PA-TEST",
  equity: 100_000,
  cash: 100_000,
  buyingPower: 200_000,
} as TradingAccount;

const CLOCK: MarketClock = {
  isOpen: true,
  timestamp: IN_WINDOW.toISOString(),
  nextOpen: "2026-09-02T13:30:00Z",
  nextClose: "2026-09-01T20:00:00Z",
};

function baseDeps(over: Partial<RunCycleDeps> = {}): RunCycleDeps {
  const order: TradingOrder = { id: "ord-1", symbol: "SPY", status: "accepted" } as TradingOrder;
  return {
    now: IN_WINDOW,
    llm: fakeLlm('{"act":true,"confidence":0.7,"reason":"clear window, IV fair","concerns":[]}'),
    getTradingAccount: async () => ACCOUNT,
    // Stubbed so the cycle's [O1] reading never reaches the network in tests.
    evaluateKillSwitch: async () => ({ tripped: false }),
    listPositions: async () => [],
    getMarketClock: async () => CLOCK,
    getSpot: async () => 505,
    getOptionSnapshots: async (symbols: string[]) =>
      new Map(
        symbols
          .filter((s) => s === SHORT || s === LONG)
          .map((s) => [s, chainRow(s, s === SHORT ? 500 : 495)]),
      ),
    getHistoricalBars: async () =>
      Array.from({ length: 25 }, (_, i) => ({
        symbol: "SPY",
        assetClass: "stock" as const,
        timestamp: `2026-08-${String(i + 1).padStart(2, "0")}T20:00:00Z`,
        open: 500,
        high: 503,
        low: 498,
        close: 500 + Math.sin(i),
        volume: 1_000_000,
      })),
    resolveContracts: async () => [
      { symbol: SHORT, side: "sell", ratioQty: 1, positionIntent: "sell_to_open" },
      { symbol: LONG, side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
    ],
    executeSignal: vi.fn(async () => order),
    recordDecision: vi.fn(
      async (d: DecisionDraft) =>
        ({ ...d, id: "dec-1", at: IN_WINDOW.toISOString() }) as DecisionRecord,
    ),
    ...over,
  };
}

async function seedOpenSpread(over: Partial<import("@/domain/agent").ManagedSpread> = {}) {
  await mutateAgentState((s) => ({
    ...s,
    spreads: [
      {
        id: "agent-entry-2026-09-01",
        underlying: "SPY",
        kind: "bull_put_spread",
        openedAt: "2026-09-01T14:05:00Z",
        entryEtDate: "2026-09-01",
        shortSymbol: SHORT,
        longSymbol: LONG,
        shortStrike: 500,
        longStrike: 495,
        width: 5,
        contracts: 2,
        credit: 0.83,
        maxLossPerSpread: 4.17,
        expiration: EXP,
        targetBuyback: 0.415,
        stopBuyback: 2.49,
        status: "open",
        ...over,
      },
    ],
  }));
}

/** The `StrategySignal` the cycle's first `executeSignal` call was given. */
function closeSignalOf(deps: RunCycleDeps): [StrategySignal] {
  const mock = deps.executeSignal as unknown as { mock: { calls: [StrategySignal][] } };
  return mock.mock.calls[0];
}

describe("runAgentCycle — entry", () => {
  it("opens a spread when the LLM approves", async () => {
    const deps = baseDeps();
    const report = await runAgentCycle(deps);

    expect(deps.executeSignal).toHaveBeenCalledOnce();
    expect(report.entry).toMatchObject({ evaluated: true, acted: true, orderId: "ord-1" });
    const state = await loadAgentState();
    expect(state.enteredEtDates).toEqual(["2026-09-01"]);
    expect(state.spreads).toHaveLength(1);
    expect(state.spreads[0].stopBuyback).toBeCloseTo(0.83 * 3);
    expect(state.spreads[0].entrySpot).toBe(505);
  });

  it("skips the entry when the LLM vetoes", async () => {
    const deps = baseDeps({
      llm: fakeLlm(
        '{"act":false,"confidence":0.2,"reason":"CPI lands tomorrow","concerns":["CPI"]}',
      ),
    });
    const report = await runAgentCycle(deps);

    expect(deps.executeSignal).not.toHaveBeenCalled();
    expect(report.entry).toMatchObject({ evaluated: true, acted: false, skipped: "llm veto" });
  });

  it("does not evaluate a second entry the same day", async () => {
    await mutateAgentState((s) => ({ ...s, enteredEtDates: ["2026-09-01"] }));
    const deps = baseDeps();
    const report = await runAgentCycle(deps);

    expect(report.entry).toEqual({ evaluated: false, reason: "already entered today" });
    expect(deps.executeSignal).not.toHaveBeenCalled();
  });

  it("does not open outside the scoring window (manage still runs)", async () => {
    const deps = baseDeps({ now: new Date("2026-08-29T14:30:00Z") });
    const report = await runAgentCycle(deps);

    expect(report.entry).toEqual({ evaluated: false, reason: "outside the scoring window" });
  });

  it("falls back to no-trade when the entry LLM is unreachable", async () => {
    const deps = baseDeps({ llm: fakeLlm(new Error("connection refused")) });
    const report = await runAgentCycle(deps);

    expect(deps.executeSignal).not.toHaveBeenCalled();
    expect(report.entry).toMatchObject({ evaluated: true, acted: false, skipped: "llm veto" });
  });

  it("records a blocked decision when executeSignal hits a guardrail", async () => {
    const deps = baseDeps({
      executeSignal: vi.fn(async () => {
        throw new Error("Risk gate: [K4] max loss per position exceeded");
      }),
    });
    const report = await runAgentCycle(deps);

    expect(report.entry).toMatchObject({ evaluated: true, acted: false });
    const recorded = (deps.recordDecision as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0] as DecisionDraft,
    );
    expect(recorded.some((d) => d.outcome.status === "blocked")).toBe(true);
    const state = await loadAgentState();
    expect(state.entryInFlightAt).toBeUndefined();
  });
});

describe("runAgentCycle — manage", () => {
  it("closes mechanically on the stop without calling the LLM", async () => {
    await seedOpenSpread();
    const now = new Date("2026-09-02T14:00:00Z");
    const llm = fakeLlm(new Error("should not be called"));
    const deps = baseDeps({
      llm,
      now,
      listPositions: async () => [{ symbol: SHORT, qty: 2, side: "short" } as TradingPosition],
      // buyback = 3.0 - 0.2 = 2.8 >= stopBuyback 2.49
      getOptionSnapshots: manageSnapshots(now, [2.95, 3.05], [0.15, 0.25]),
    });

    const report = await runAgentCycle(deps);

    expect(llm.complete).not.toHaveBeenCalled();
    const managed = report.managed.find((m) => m.id === "agent-entry-2026-09-01");
    expect(managed?.zone).toBe("stop");
    expect(managed?.action).toBe("closed");
  });

  it("closes early when the dead-zone LLM says close", async () => {
    await seedOpenSpread();
    const now = new Date("2026-09-02T19:00:00Z"); // ~60 min to 20:00Z expiry -> low on time
    const deps = baseDeps({
      llm: fakeLlm(
        '{"action":"close","reason":"break of support toward the strike","urgency":"high"}',
      ),
      now,
      listPositions: async () => [{ symbol: SHORT, qty: 2, side: "short" } as TradingPosition],
      getSpot: async () => 501,
      // buyback ~1.1 -> losing but not at the stop
      getOptionSnapshots: manageSnapshots(now, [1.25, 1.35], [0.15, 0.25]),
    });

    const report = await runAgentCycle(deps);
    const managed = report.managed.find((m) => m.id === "agent-entry-2026-09-01");
    expect(managed?.zone).toBe("dead_zone");
    expect(managed?.action).toBe("closed");
    expect(deps.executeSignal).toHaveBeenCalled();
  });

  it("holds a dead-zone spread when the manage LLM is unreachable", async () => {
    await seedOpenSpread();
    const now = new Date("2026-09-02T19:00:00Z");
    const deps = baseDeps({
      llm: fakeLlm(new Error("timeout")),
      now,
      listPositions: async () => [{ symbol: SHORT, qty: 2, side: "short" } as TradingPosition],
      getSpot: async () => 501,
      getOptionSnapshots: manageSnapshots(now, [1.25, 1.35], [0.15, 0.25]),
    });

    const report = await runAgentCycle(deps);
    const managed = report.managed.find((m) => m.id === "agent-entry-2026-09-01");
    expect(managed?.zone).toBe("dead_zone");
    expect(managed?.action).toBe("hold");
    const state = await loadAgentState();
    expect(state.spreads[0].status).toBe("open");
  });

  it("force-closes before the equity snapshot regardless of P&L", async () => {
    await seedOpenSpread({ expiration: "2026-09-03" });
    const now = new Date("2026-09-03T19:30:00Z"); // 30 min to the 20:00Z snapshot
    const deps = baseDeps({
      now,
      listPositions: async () => [{ symbol: SHORT, qty: 2, side: "short" } as TradingPosition],
      getOptionSnapshots: manageSnapshots(now, [0.4, 0.5], [0.1, 0.15], "2026-09-03"),
    });

    const report = await runAgentCycle(deps);
    const managed = report.managed.find((m) => m.id === "agent-entry-2026-09-01");
    expect(managed?.zone).toBe("deadline");
    expect(managed?.action).toBe("closed");
    expect(report.entry).toEqual({ evaluated: false, reason: "too close to the equity snapshot" });
  });

  it("sends the pre-snapshot forced close at market, not on a limit", async () => {
    await seedOpenSpread({ expiration: "2026-09-03" });
    const now = new Date("2026-09-03T19:30:00Z");
    const deps = baseDeps({
      now,
      listPositions: async () => [{ symbol: SHORT, qty: 2, side: "short" } as TradingPosition],
      getOptionSnapshots: manageSnapshots(now, [0.4, 0.5], [0.1, 0.15], "2026-09-03"),
    });

    await runAgentCycle(deps);
    const [signal] = closeSignalOf(deps);
    expect(signal.orderType).toBe("market");
    expect(signal.entryLimit).toBeUndefined();
  });

  it("leaves a still-working close order alone rather than duplicating it", async () => {
    const now = new Date("2026-09-02T14:00:00Z");
    await seedOpenSpread({ status: "closing", closeOrderId: "close-1" });
    const deps = baseDeps({
      now,
      listPositions: async () => [{ symbol: SHORT, qty: 2, side: "short" } as TradingPosition],
      getOptionSnapshots: manageSnapshots(now, [0.5, 0.6], [0.1, 0.15]),
      getOrder: async () =>
        ({
          id: "close-1",
          status: "accepted",
          submittedAt: new Date(now.getTime() - 10_000).toISOString(),
        }) as TradingOrder,
    });

    const report = await runAgentCycle(deps);
    expect(deps.executeSignal).not.toHaveBeenCalled();
    expect(report.managed[0].action).toBe("closing");
    expect((await loadAgentState()).spreads[0].status).toBe("closing");
  });

  it("re-closes at market when the close order never filled", async () => {
    const now = new Date("2026-09-02T14:00:00Z");
    await seedOpenSpread({ status: "closing", closeOrderId: "close-1" });
    const cancelOrder = vi.fn(async () => undefined);
    const deps = baseDeps({
      now,
      cancelOrder,
      listPositions: async () => [{ symbol: SHORT, qty: 2, side: "short" } as TradingPosition],
      // Buyback 3.0 >= stopBuyback 2.49 -> the stop is armed again once re-opened.
      getOptionSnapshots: manageSnapshots(now, [3.2, 3.3], [0.2, 0.3]),
      getOrder: async () =>
        ({
          id: "close-1",
          status: "accepted",
          submittedAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
        }) as TradingOrder,
    });

    const report = await runAgentCycle(deps);
    expect(cancelOrder).toHaveBeenCalledWith("close-1");
    expect(deps.executeSignal).toHaveBeenCalledOnce();
    const [signal] = closeSignalOf(deps);
    expect(signal.orderType).toBe("market");
    expect(report.managed[0].zone).toBe("stop");
    expect(report.managed[0].action).toBe("closed");
  });

  it("reconciles a spread stuck in `closing` once its legs are gone", async () => {
    await seedOpenSpread({ status: "closing", closeOrderId: "close-1" });
    const deps = baseDeps({
      now: new Date("2026-09-02T14:00:00Z"),
      listPositions: async () => [],
    });

    await runAgentCycle(deps);
    expect((await loadAgentState()).spreads[0].status).toBe("closed");
  });

  it("reconciles a spread whose legs are no longer held", async () => {
    await seedOpenSpread();
    const deps = baseDeps({
      now: new Date("2026-09-02T14:00:00Z"),
      listPositions: async () => [], // legs gone -> filled/expired elsewhere
    });

    const report = await runAgentCycle(deps);
    const state = await loadAgentState();
    expect(state.spreads[0].status).toBe("closed");
    expect(state.spreads[0].closeReason).toBe("reconciled/expired");
    expect(report.managed[0].action).toBe("hold");
  });
});
