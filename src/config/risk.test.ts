import { describe, expect, it } from "vitest";
import type { MarketClock, OptionQuoteRow } from "@/domain/types";
import {
  aggregateExposure,
  checkChainSanity,
  checkExecutionWindow,
  checkPortfolioRisk,
  type PositionExposure,
  quoteAnomalies,
  RISK,
  readDrawdown,
  sectorOf,
} from "./risk";

const ACCOUNT = { equity: 100_000, buyingPower: 80_000 };

function position(overrides: Partial<PositionExposure> = {}): PositionExposure {
  return {
    symbol: "SPY260902C00500000",
    underlying: "SPY",
    contracts: 1,
    marketValue: 500,
    riskAmount: 500,
    delta: 0.4,
    vega: 0.1,
    spot: 500,
    ...overrides,
  };
}

function row(overrides: Partial<OptionQuoteRow> = {}): OptionQuoteRow {
  return {
    symbol: "SPY260902C00500000",
    underlying: "SPY",
    expiration: "2026-09-02",
    type: "call",
    strike: 500,
    bid: 4.9,
    ask: 5.1,
    mark: 5,
    impliedVolatility: 0.2,
    ...overrides,
  };
}

describe("aggregateExposure", () => {
  it("sums dollar-delta and vega across the book", () => {
    const e = aggregateExposure([position(), position({ contracts: 2 })], ACCOUNT, 500);
    // (0.4 * 100 * 1 * 500) + (0.4 * 100 * 2 * 500)
    expect(e.netDeltaNotional).toBe(60_000);
    expect(e.netVegaUsd).toBeCloseTo(30, 6);
    expect(e.netDeltaSpyShares).toBe(120);
    expect(e.positionCount).toBe(2);
  });

  it("nets short legs against long ones", () => {
    const e = aggregateExposure([position(), position({ contracts: -1 })], ACCOUNT, 500);
    expect(e.netDeltaNotional).toBe(0);
  });

  it("degrades to null rather than treating a missing greek as zero", () => {
    const e = aggregateExposure([position(), position({ delta: null })], ACCOUNT);
    expect(e.netDeltaNotional).toBeNull();
    expect(e.netVegaUsd).not.toBeNull();
  });

  it("flags positions whose risk amount is unknown", () => {
    const e = aggregateExposure([position({ riskAmount: null })], ACCOUNT);
    expect(e.unpricedPositions).toEqual(["SPY260902C00500000"]);
  });

  it("derives buying power used from equity minus available", () => {
    const e = aggregateExposure([], { equity: 100_000, buyingPower: 70_000 });
    expect(e.buyingPowerUsedPct).toBeCloseTo(0.3, 6);
  });
});

describe("checkPortfolioRisk", () => {
  const clean = aggregateExposure([], ACCOUNT);

  it("passes an empty book with a modest candidate", () => {
    const v = checkPortfolioRisk(clean, {
      underlying: "SPY",
      riskAmount: 500,
      deltaNotional: 20_000,
      vegaUsd: 50,
    });
    expect(v.allowed).toBe(true);
  });

  it("[K4] refuses a candidate over the per-position loss cap", () => {
    const v = checkPortfolioRisk(clean, {
      underlying: "SPY",
      riskAmount: 5_000, // 5% of 100k, cap is 2%
      deltaNotional: 0,
      vegaUsd: 0,
    });
    expect(v.allowed).toBe(false);
    expect(v.violations.join()).toContain("[K4]");
  });

  it("[K4] refuses a candidate whose risk could not be established", () => {
    const v = checkPortfolioRisk(clean, {
      underlying: "SPY",
      riskAmount: null,
      deltaNotional: 0,
      vegaUsd: 0,
    });
    expect(v.allowed).toBe(false);
    expect(v.violations.join()).toContain("unquantified risk");
  });

  it("[K3] refuses when buying power used is over the cap", () => {
    const e = aggregateExposure([], { equity: 100_000, buyingPower: 40_000 });
    expect(checkPortfolioRisk(e).violations.join()).toContain("[K3]");
  });

  it("[K6] refuses past the concurrent position cap", () => {
    const positions = Array.from({ length: RISK.maxConcurrentPositions }, (_, i) =>
      position({ symbol: `SPY26090${i}C00500000`, underlying: "SPY" }),
    );
    const e = aggregateExposure(positions, ACCOUNT);
    const v = checkPortfolioRisk(e, {
      underlying: "SPY",
      riskAmount: 100,
      deltaNotional: 0,
      vegaUsd: 0,
    });
    expect(v.violations.join()).toContain("[K6]");
  });

  it("[K5] treats same-sector positions as one macro position", () => {
    const e = aggregateExposure(
      [
        position({ symbol: "AAPL260902C00200000", underlying: "AAPL" }),
        position({ symbol: "MSFT260902C00400000", underlying: "MSFT" }),
      ],
      ACCOUNT,
    );
    const v = checkPortfolioRisk(e, {
      underlying: "NVDA",
      riskAmount: 100,
      deltaNotional: 0,
      vegaUsd: 0,
    });
    expect(v.violations.join()).toContain("[K5]");
    expect(v.violations.join()).toContain("mega-tech");
  });

  it("[K1] refuses when projected net dollar-delta breaks the cap", () => {
    const v = checkPortfolioRisk(clean, {
      underlying: "SPY",
      riskAmount: 100,
      deltaNotional: 100_000, // cap is 60% of 100k
      vegaUsd: 0,
    });
    expect(v.violations.join()).toContain("[K1]");
  });

  it("[K1] caps the short side symmetrically", () => {
    const v = checkPortfolioRisk(clean, {
      underlying: "SPY",
      riskAmount: 100,
      deltaNotional: -100_000,
      vegaUsd: 0,
    });
    expect(v.violations.join()).toContain("[K1]");
  });

  it("[K2] refuses when net vega breaks the cap", () => {
    const v = checkPortfolioRisk(clean, {
      underlying: "SPY",
      riskAmount: 100,
      deltaNotional: 0,
      vegaUsd: 1_000, // cap is 0.4% of 100k = 400
    });
    expect(v.violations.join()).toContain("[K2]");
  });

  it("warns rather than passing silently when greeks are unavailable", () => {
    const e = aggregateExposure([position({ delta: null, vega: null })], ACCOUNT);
    const v = checkPortfolioRisk(e);
    expect(v.warnings.join()).toContain("[K1]");
    expect(v.warnings.join()).toContain("cap not checked");
  });

  it("refuses to reason about a non-positive equity", () => {
    const v = checkPortfolioRisk(aggregateExposure([], { equity: 0, buyingPower: 0 }));
    expect(v.allowed).toBe(false);
  });
});

describe("sectorOf", () => {
  it("groups index ETFs and mega-cap tech into their own buckets", () => {
    expect(sectorOf("spy")).toBe("broad-market");
    expect(sectorOf("NVDA")).toBe("mega-tech");
  });

  it("gives an unmapped underlying its own bucket rather than grouping it", () => {
    expect(sectorOf("ZZZZ")).toBe("unmapped:ZZZZ");
  });
});

describe("readDrawdown [O1]", () => {
  it("measures against the session's opening equity", () => {
    const r = readDrawdown({ equity: 95_000, lastEquity: 100_000 });
    expect(r.drawdownPct).toBeCloseTo(0.05, 6);
    expect(r.tripped).toBe(false);
  });

  it("trips past the limit", () => {
    const r = readDrawdown({ equity: 90_000, lastEquity: 100_000 });
    expect(r.tripped).toBe(true);
  });

  it("does not trip on a gain", () => {
    expect(readDrawdown({ equity: 110_000, lastEquity: 100_000 }).tripped).toBe(false);
  });

  it("falls back to current equity when there is no previous close", () => {
    expect(readDrawdown({ equity: 100_000 }).drawdownPct).toBe(0);
  });
});

describe("quoteAnomalies [O2]", () => {
  const now = new Date("2026-09-01T15:00:00Z");

  it("accepts a sane two-sided quote", () => {
    expect(quoteAnomalies(row(), now)).toEqual([]);
  });

  it("rejects a zero bid — no bid means no exit", () => {
    expect(quoteAnomalies(row({ bid: 0 }), now).join()).toContain("no exit");
  });

  it("rejects a crossed book", () => {
    expect(quoteAnomalies(row({ bid: 5.2, ask: 5.1 }), now).join()).toContain("crossed");
  });

  it("rejects an implausible spread", () => {
    expect(quoteAnomalies(row({ bid: 1, ask: 9 }), now).join()).toContain("spread");
  });

  it("rejects an impossible implied volatility", () => {
    expect(quoteAnomalies(row({ impliedVolatility: 7 }), now).join()).toContain("not a market");
  });

  it("rejects a stale quote", () => {
    const stale = row({ updatedAt: "2026-09-01T14:00:00Z" });
    expect(quoteAnomalies(stale, now).join()).toContain("stale");
  });

  it("rejects a one-sided quote", () => {
    expect(quoteAnomalies(row({ bid: undefined }), now).join()).toContain("two-sided");
  });

  it("checkChainSanity fails the whole set when one row is bad", () => {
    expect(checkChainSanity([row(), row({ bid: 0 })], now).allowed).toBe(false);
  });
});

describe("checkExecutionWindow [O3]", () => {
  const clock = (isOpen: boolean, nextClose: string): MarketClock => ({
    isOpen,
    timestamp: nextClose,
    nextOpen: "2026-09-02T13:30:00Z",
    nextClose,
  });
  // Session: 2026-09-01 13:30Z -> 20:00Z
  const close = "2026-09-01T20:00:00Z";

  it("allows mid-session", () => {
    expect(checkExecutionWindow(clock(true, close), new Date("2026-09-01T16:00:00Z")).allowed).toBe(
      true,
    );
  });

  it("blocks the first ten minutes", () => {
    const v = checkExecutionWindow(clock(true, close), new Date("2026-09-01T13:35:00Z"));
    expect(v.allowed).toBe(false);
    expect(v.violations.join()).toContain("into the session");
  });

  it("blocks the last ten minutes", () => {
    const v = checkExecutionWindow(clock(true, close), new Date("2026-09-01T19:55:00Z"));
    expect(v.allowed).toBe(false);
    expect(v.violations.join()).toContain("to the close");
  });

  it("blocks a closed market", () => {
    expect(
      checkExecutionWindow(clock(false, close), new Date("2026-09-01T16:00:00Z")).allowed,
    ).toBe(false);
  });

  it("allows an explicit session open to override the derived one", () => {
    const v = checkExecutionWindow(
      clock(true, close),
      new Date("2026-09-01T13:35:00Z"),
      new Date("2026-09-01T13:00:00Z"),
    );
    expect(v.allowed).toBe(true);
  });
});
