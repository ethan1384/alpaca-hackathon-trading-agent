import { describe, expect, it } from "vitest";
import { AGENT } from "@/config/agent";
import { StrategySignalSchema } from "@/domain/strategy";
import type { TradingAccount } from "@/domain/trading";
import type { OptionQuoteRow } from "@/domain/types";
import { buildOptionSymbol } from "@/domain/types";
import { buildCreditSpreadCandidate, type CreditSpreadDeps } from "./credit-spread-strategy";

const NOW = new Date("2026-09-01T14:00:00Z"); // Tue, ET date 2026-09-01
const EXP = "2026-09-02"; // 1 DTE, inside the judged window (deadline 09-03)
const SHORT = buildOptionSymbol({ underlying: "SPY", expiration: EXP, type: "put", strike: 500 });
const LONG = buildOptionSymbol({ underlying: "SPY", expiration: EXP, type: "put", strike: 495 });

function snap(overrides: Partial<Record<string, Partial<OptionQuoteRow>>> = {}) {
  const base: Record<string, OptionQuoteRow> = {
    [SHORT]: {
      symbol: SHORT,
      underlying: "SPY",
      expiration: EXP,
      type: "put",
      strike: 500,
      bid: 1.3,
      ask: 1.4,
      mark: 1.35,
      openInterest: 5000,
      impliedVolatility: 0.18,
      greeks: { delta: -0.18, vega: 0.05 },
      updatedAt: NOW.toISOString(),
    } as OptionQuoteRow,
    [LONG]: {
      symbol: LONG,
      underlying: "SPY",
      expiration: EXP,
      type: "put",
      strike: 495,
      bid: 0.45,
      ask: 0.55,
      mark: 0.5,
      openInterest: 5000,
      impliedVolatility: 0.2,
      greeks: { delta: -0.1, vega: 0.04 },
      updatedAt: NOW.toISOString(),
    } as OptionQuoteRow,
  };
  return new Map(
    Object.entries(base).map(([k, v]) => [k, { ...v, ...(overrides[k] ?? {}) } as OptionQuoteRow]),
  );
}

function deps(over: Partial<CreditSpreadDeps> = {}): CreditSpreadDeps {
  return {
    resolveContracts: async () => [
      { symbol: SHORT, side: "sell", ratioQty: 1, positionIntent: "sell_to_open" },
      { symbol: LONG, side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
    ],
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
    getOptionSnapshots: async () => snap(),
    getSpot: async () => 501,
    getTradingAccount: async () =>
      ({ equity: 100_000, cash: 100_000, buyingPower: 200_000 }) as TradingAccount,
    ...over,
  };
}

describe("buildCreditSpreadCandidate", () => {
  it("builds a schema-valid, sized put credit spread on the happy path", async () => {
    const out = await buildCreditSpreadCandidate(deps(), 0, NOW);
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // mid credit = 1.35 - 0.50 = 0.85; entryLimit = 0.83
    expect(out.candidate.rationale.entryLimit).toBeCloseTo(0.83);
    expect(out.candidate.rationale.width).toBe(5);
    // max loss 4.17/spread -> 417/contract; 1% of 100k = 1000 -> 2 contracts
    expect(out.candidate.sizing.contracts).toBe(2);
    expect(out.candidate.sizing.riskAmount).toBeCloseTo(417 * 2);
    expect(StrategySignalSchema.safeParse(out.candidate.signal).success).toBe(true);
    expect(out.candidate.signal.resolvedLegs?.[0].side).toBe("sell");
  });

  it("sizes off the risk budget alone, not the open-position count", async () => {
    // One spread already open is under the concurrency cap, so the risk budget
    // still buys the full 2 contracts — the cap counts positions, not contracts.
    const out = await buildCreditSpreadCandidate(deps(), 1, NOW);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.candidate.sizing.contracts).toBe(2);
  });

  it("refuses a new spread once the concurrency cap is reached", async () => {
    const out = await buildCreditSpreadCandidate(deps(), AGENT.maxConcurrentSpreads, NOW);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.skip).toBe("size_below_one_contract");
  });

  it("skips when the credit is below the floor", async () => {
    const d = deps({
      getOptionSnapshots: async () => snap({ [SHORT]: { bid: 0.6, ask: 0.66, mark: 0.63 } }),
    });
    const out = await buildCreditSpreadCandidate(d, 0, NOW);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.skip).toBe("credit_below_min");
  });

  it("skips when the credit clears the absolute floor but is too thin for the width", async () => {
    // short mid 0.90, long mid 0.50 -> credit 0.40, entryLimit 0.38: above
    // minCredit (0.25) but 0.38/5 = 0.076 < minCreditRatio (0.10).
    const d = deps({
      getOptionSnapshots: async () => snap({ [SHORT]: { bid: 0.87, ask: 0.93, mark: 0.9 } }),
    });
    const out = await buildCreditSpreadCandidate(d, 0, NOW);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.skip).toBe("credit_ratio_too_thin");
  });

  it("skips when the short leg is too close to the money", async () => {
    const d = deps({
      getOptionSnapshots: async () => snap({ [SHORT]: { greeks: { delta: -0.4, vega: 0.05 } } }),
    });
    const out = await buildCreditSpreadCandidate(d, 0, NOW);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.skip).toBe("short_strike_too_close");
  });

  it("skips when a leg quote is anomalous", async () => {
    const d = deps({
      getOptionSnapshots: async () => snap({ [SHORT]: { bid: 0, ask: 0 } }),
    });
    const out = await buildCreditSpreadCandidate(d, 0, NOW);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.skip).toBe("unpriceable_chain");
  });

  it("skips when no two-leg structure resolves", async () => {
    const d = deps({ resolveContracts: async () => [] });
    const out = await buildCreditSpreadCandidate(d, 0, NOW);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.skip).toBe("no_contracts_in_window");
  });

  it("skips when the resolved expiry is past the judged snapshot", async () => {
    const past = buildOptionSymbol({
      underlying: "SPY",
      expiration: "2026-09-11",
      type: "put",
      strike: 500,
    });
    const pastLong = buildOptionSymbol({
      underlying: "SPY",
      expiration: "2026-09-11",
      type: "put",
      strike: 495,
    });
    const d = deps({
      resolveContracts: async () => [
        { symbol: past, side: "sell", ratioQty: 1, positionIntent: "sell_to_open" },
        { symbol: pastLong, side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
      ],
    });
    const out = await buildCreditSpreadCandidate(d, 0, NOW);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.skip).toBe("expiry_past_snapshot");
  });

  it("skips when the account equity is unavailable", async () => {
    const d = deps({ getTradingAccount: async () => ({ equity: 0 }) as TradingAccount });
    const out = await buildCreditSpreadCandidate(d, 0, NOW);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.skip).toBe("account_equity_unavailable");
  });
});
