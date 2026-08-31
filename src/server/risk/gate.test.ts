import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/config/env";
import { StrategySignalSchema } from "@/domain/strategy";
import type { MarketClock, OptionQuoteRow } from "@/domain/types";
import { assertTradeAllowed, checkTrade, isRiskEnforced } from "./gate";
import { rearmKillSwitch, tripKillSwitch } from "./kill-switch";

const ORIGINAL_ENV = { ...process.env };
const NOW = new Date("2026-09-01T16:00:00Z");
const SYMBOL = "SPY260902C00500000";

function signal() {
  return StrategySignalSchema.parse({
    strategy: "test",
    underlying: "SPY",
    bias: "bullish",
    kind: "long_call",
    selection: { minDte: 1, maxDte: 4 },
    confidence: 0.7,
    reason: "test",
    entryLimit: 5,
    timestamp: NOW.toISOString(),
    resolvedLegs: [{ symbol: SYMBOL, side: "buy", ratioQty: 1, positionIntent: "buy_to_open" }],
  });
}

const CLOCK: MarketClock = {
  isOpen: true,
  timestamp: NOW.toISOString(),
  nextOpen: "2026-09-02T13:30:00Z",
  nextClose: "2026-09-01T20:00:00Z",
};

function snapshot(overrides: Partial<OptionQuoteRow> = {}): OptionQuoteRow {
  return {
    symbol: SYMBOL,
    underlying: "SPY",
    expiration: "2026-09-02",
    type: "call",
    strike: 500,
    bid: 4.9,
    ask: 5.1,
    mark: 5,
    impliedVolatility: 0.2,
    greeks: { delta: 0.4, vega: 0.1 },
    ...overrides,
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    getMarketClock: async () => CLOCK,
    getOptionSnapshots: async () => new Map([[SYMBOL, snapshot()]]),
    getTradingAccount: async () => ({
      id: "a",
      status: "ACTIVE",
      currency: "USD",
      cash: 100_000,
      equity: 100_000,
      lastEquity: 100_000,
      buyingPower: 90_000,
    }),
    listPositions: async () => [],
    getSpot: async () => 500,
    ...overrides,
  };
}

describe("risk gate", () => {
  beforeEach(() => {
    rearmKillSwitch();
    resetEnvCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    resetEnvCache();
  });

  it("allows a modest opening trade on a clean book", async () => {
    const result = await checkTrade(signal(), signal().resolvedLegs ?? [], deps(), NOW);
    expect(result.violations).toEqual([]);
    expect(result.allowed).toBe(true);
  });

  it("[O1] refuses everything once the kill switch is tripped, without any I/O", async () => {
    const getMarketClock = vi.fn(async () => CLOCK);
    await tripKillSwitch("drill", {
      cancelAllOrders: async () => [],
      closeAllPositions: async () => [],
    });
    const result = await checkTrade(
      signal(),
      signal().resolvedLegs ?? [],
      deps({ getMarketClock }),
      NOW,
    );
    expect(result.allowed).toBe(false);
    expect(result.violations.join()).toContain("[O1]");
    expect(getMarketClock).not.toHaveBeenCalled();
  });

  it("[O3] refuses inside the closing blackout", async () => {
    const result = await checkTrade(
      signal(),
      signal().resolvedLegs ?? [],
      deps(),
      new Date("2026-09-01T19:55:00Z"),
    );
    expect(result.violations.join()).toContain("[O3]");
  });

  it("[O2] refuses on an aberrant quote", async () => {
    const result = await checkTrade(
      signal(),
      signal().resolvedLegs ?? [],
      deps({ getOptionSnapshots: async () => new Map([[SYMBOL, snapshot({ bid: 0 })]]) }),
      NOW,
    );
    expect(result.violations.join()).toContain("[O2]");
  });

  it("[O2] refuses when a leg returns no snapshot at all", async () => {
    const result = await checkTrade(
      signal(),
      signal().resolvedLegs ?? [],
      deps({ getOptionSnapshots: async () => new Map() }),
      NOW,
    );
    expect(result.violations.join()).toContain("returned no snapshot");
  });

  it("[O2] freezes entries when the snapshot call itself fails", async () => {
    const result = await checkTrade(
      signal(),
      signal().resolvedLegs ?? [],
      deps({
        getOptionSnapshots: async () => {
          throw new Error("feed down");
        },
      }),
      NOW,
    );
    expect(result.violations.join()).toContain("entries frozen");
  });

  it("[K] refuses rather than sizing against a book it could not read", async () => {
    const result = await checkTrade(
      signal(),
      signal().resolvedLegs ?? [],
      deps({
        listPositions: async () => {
          throw new Error("positions unavailable");
        },
      }),
      NOW,
    );
    expect(result.violations.join()).toContain("unknown book");
  });

  it("[K4] refuses a candidate over the per-position loss cap", async () => {
    const big = StrategySignalSchema.parse({ ...signal(), entryLimit: 5, maxContracts: 10 });
    const result = await checkTrade(big, big.resolvedLegs ?? [], deps(), NOW);
    // 5 * 100 * 10 = $5,000 risk vs a $2,000 cap on $100k equity
    expect(result.violations.join()).toContain("[K4]");
  });

  it("assertTradeAllowed is a no-op when RISK_ENFORCE is off", async () => {
    process.env.RISK_ENFORCE = "false";
    resetEnvCache();
    expect(isRiskEnforced()).toBe(false);
    const failing = deps({
      getMarketClock: async () => {
        throw new Error("must not be called");
      },
    });
    const result = await assertTradeAllowed(signal(), signal().resolvedLegs ?? [], failing, NOW);
    expect(result.evaluated).toBe(false);
    expect(result.allowed).toBe(true);
  });

  it("assertTradeAllowed throws on a breach when RISK_ENFORCE is on", async () => {
    process.env.ALPACA_API_KEY = "k";
    process.env.ALPACA_API_SECRET = "s";
    process.env.RISK_ENFORCE = "true";
    resetEnvCache();
    await expect(
      assertTradeAllowed(
        signal(),
        signal().resolvedLegs ?? [],
        deps(),
        new Date("2026-09-01T19:55:00Z"),
      ),
    ).rejects.toThrow(/Risk gate/);
  });
});
