import { describe, expect, it } from "vitest";
import {
  creditSpreadValue,
  cumulativeNormal,
  optionDelta,
  optionPrice,
  realisedVolatility,
  strikeForDelta,
  TRADING_MINUTES_PER_SESSION,
  tradingYears,
  verticalValue,
  yearsBetween,
} from "./black-scholes";

const T = 6 / (24 * 365); // ~6 hours, a 0DTE morning entry
const R = 0.04;
const IV = 0.18;

describe("cumulativeNormal", () => {
  it("is 0.5 at the mean and symmetric around it", () => {
    expect(cumulativeNormal(0)).toBeCloseTo(0.5, 6);
    expect(cumulativeNormal(1) + cumulativeNormal(-1)).toBeCloseTo(1, 6);
  });

  it("matches known quantiles", () => {
    expect(cumulativeNormal(1.96)).toBeCloseTo(0.975, 4);
    expect(cumulativeNormal(-2.5758)).toBeCloseTo(0.005, 4);
  });
});

describe("optionPrice", () => {
  it("satisfies put-call parity", () => {
    const call = optionPrice("call", 640, 638, T, R, IV);
    const put = optionPrice("put", 640, 638, T, R, IV);
    expect(call - put).toBeCloseTo(640 - 638 * Math.exp(-R * T), 6);
  });

  it("collapses to intrinsic value at expiry", () => {
    expect(optionPrice("call", 645, 640, 0, R, IV)).toBeCloseTo(5, 10);
    expect(optionPrice("call", 635, 640, 0, R, IV)).toBe(0);
    expect(optionPrice("put", 635, 640, 0, R, IV)).toBeCloseTo(5, 10);
  });

  it("is worth more with more time", () => {
    const near = optionPrice("call", 640, 640, T, R, IV);
    const far = optionPrice("call", 640, 640, T * 4, R, IV);
    expect(far).toBeGreaterThan(near);
  });
});

describe("optionDelta", () => {
  it("is near 0.5 at the money", () => {
    expect(optionDelta("call", 640, 640, T, R, IV)).toBeCloseTo(0.5, 1);
    expect(optionDelta("put", 640, 640, T, R, IV)).toBeCloseTo(-0.5, 1);
  });

  it("is binary at expiry", () => {
    expect(optionDelta("call", 645, 640, 0, R, IV)).toBe(1);
    expect(optionDelta("call", 635, 640, 0, R, IV)).toBe(0);
    expect(optionDelta("put", 635, 640, 0, R, IV)).toBe(-1);
  });
});

describe("verticalValue", () => {
  it("stays inside [0, width]", () => {
    const width = 3;
    for (const spot of [600, 630, 640, 641, 650, 700]) {
      const value = verticalValue("call", spot, 640, 643, T, R, IV);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(width);
    }
  });

  it("reaches max value when both legs finish deep in the money", () => {
    expect(verticalValue("call", 700, 640, 643, 0, R, IV)).toBeCloseTo(3, 6);
  });

  it("expires worthless when the long leg finishes out of the money", () => {
    expect(verticalValue("call", 630, 640, 643, 0, R, IV)).toBe(0);
  });

  it("prices a bear put spread symmetrically", () => {
    expect(verticalValue("put", 580, 640, 637, 0, R, IV)).toBeCloseTo(3, 6);
    expect(verticalValue("put", 700, 640, 637, 0, R, IV)).toBe(0);
  });
});

describe("realisedVolatility", () => {
  it("returns null on too short a series", () => {
    expect(realisedVolatility([100, 101])).toBeNull();
  });

  it("is zero on a flat series", () => {
    expect(realisedVolatility([100, 100, 100, 100])).toBeCloseTo(0, 10);
  });

  it("grows with dispersion", () => {
    const calm = realisedVolatility([100, 100.1, 100.2, 100.1, 100.3]);
    const wild = realisedVolatility([100, 103, 98, 104, 97]);
    expect(calm).not.toBeNull();
    expect(wild).not.toBeNull();
    expect(wild as number).toBeGreaterThan(calm as number);
  });
});

describe("strikeForDelta", () => {
  it("finds a strike whose delta is close to the target", () => {
    const strike = strikeForDelta("call", 640, 0.45, T, R, IV, 1);
    const delta = optionDelta("call", 640, strike, T, R, IV);
    expect(Math.abs(delta - 0.45)).toBeLessThan(0.06);
  });

  it("places a 0.45-delta call at or just above spot", () => {
    const strike = strikeForDelta("call", 640, 0.45, T, R, IV, 1);
    expect(strike).toBeGreaterThanOrEqual(640);
  });

  it("respects the strike grid", () => {
    const strike = strikeForDelta("call", 640.4, 0.45, T, R, IV, 5);
    expect(strike % 5).toBe(0);
  });
});

describe("yearsBetween", () => {
  it("floors at zero once the deadline has passed", () => {
    expect(yearsBetween(new Date("2026-09-03T21:00:00Z"), new Date("2026-09-03T20:00:00Z"))).toBe(
      0,
    );
  });

  it("measures a session in fractions of a year", () => {
    const years = yearsBetween(new Date("2026-09-03T13:30:00Z"), new Date("2026-09-03T20:00:00Z"));
    expect(years).toBeCloseTo(6.5 / (24 * 365), 10);
  });
});

describe("creditSpreadValue", () => {
  const t = 1 / 252;

  it("is the cost to buy back a short vertical, never negative, never above the width", () => {
    for (const spot of [600, 630, 640, 645, 700]) {
      const put = creditSpreadValue("put", spot, 635, 630, t, 0.04, 0.15);
      const call = creditSpreadValue("call", spot, 645, 650, t, 0.04, 0.15);
      expect(put).toBeGreaterThanOrEqual(0);
      expect(put).toBeLessThanOrEqual(5);
      expect(call).toBeGreaterThanOrEqual(0);
      expect(call).toBeLessThanOrEqual(5);
    }
  });

  it("costs more to close as the underlying moves through the short strike", () => {
    const near = creditSpreadValue("put", 640, 635, 630, t, 0.04, 0.15);
    const through = creditSpreadValue("put", 632, 635, 630, t, 0.04, 0.15);
    expect(through).toBeGreaterThan(near);
  });

  it("matches the debit vertical it is the other side of", () => {
    // Same two legs, opposite books: what the seller pays is what the buyer receives.
    expect(creditSpreadValue("call", 640, 645, 650, t, 0.04, 0.15)).toBeCloseTo(
      verticalValue("call", 640, 645, 650, t, 0.04, 0.15),
      12,
    );
  });
});

describe("tradingYears", () => {
  it("counts one session as 1/252 of a year", () => {
    expect(tradingYears(TRADING_MINUTES_PER_SESSION)).toBeCloseTo(1 / 252, 12);
  });

  it("ignores the hours the market is shut", () => {
    // Friday 10:00 to Monday 16:00 is 78 calendar hours but two sessions.
    const minutes = 360 + TRADING_MINUTES_PER_SESSION;
    expect(tradingYears(minutes)).toBeCloseTo((360 + 390) / (252 * 390), 12);
    expect(tradingYears(minutes)).toBeLessThan(yearsBetween(new Date(0), new Date(78 * 3_600_000)));
  });

  it("floors at zero rather than going negative past expiry", () => {
    expect(tradingYears(-100)).toBe(0);
  });
});
