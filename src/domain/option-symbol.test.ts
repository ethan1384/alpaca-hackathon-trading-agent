import { describe, expect, it } from "vitest";
import {
  buildOptionSymbol,
  detectAssetClass,
  displayInstrumentLabel,
  formatOptionLabel,
  isNearTheMoney,
  optionMoneyness,
  parseOptionSymbol,
} from "./types";

describe("detectAssetClass", () => {
  it("classifies OCC option symbols", () => {
    expect(detectAssetClass("AAPL260116C00150000")).toBe("option");
    expect(detectAssetClass("SPY251219P00500000")).toBe("option");
  });

  it("still classifies stocks and crypto", () => {
    expect(detectAssetClass("AAPL")).toBe("stock");
    expect(detectAssetClass("BTC/USD")).toBe("crypto");
  });
});

describe("parseOptionSymbol", () => {
  it("parses a call contract", () => {
    expect(parseOptionSymbol("AAPL260116C00150000")).toEqual({
      symbol: "AAPL260116C00150000",
      underlying: "AAPL",
      expiration: "2026-01-16",
      type: "call",
      strike: 150,
    });
  });

  it("parses a fractional strike put", () => {
    expect(parseOptionSymbol("TSLA260320P00247500")).toMatchObject({
      type: "put",
      strike: 247.5,
    });
  });

  it("returns null for non-option symbols", () => {
    expect(parseOptionSymbol("AAPL")).toBeNull();
    expect(parseOptionSymbol("BTC/USD")).toBeNull();
  });
});

describe("buildOptionSymbol", () => {
  it("round-trips with parseOptionSymbol", () => {
    const occ = "AAPL260116C00150000";
    const parsed = parseOptionSymbol(occ);
    if (!parsed) {
      throw new Error("expected parsed contract");
    }
    const { symbol: _symbol, ...contract } = parsed;
    expect(buildOptionSymbol(contract)).toBe(occ);
  });
});

describe("formatOptionLabel", () => {
  it("renders a readable label", () => {
    const parsed = parseOptionSymbol("AAPL260116C00150000");
    if (!parsed) {
      throw new Error("expected parsed contract");
    }
    expect(formatOptionLabel(parsed)).toBe("AAPL Call 150 $ · 16 jan. 2026");
  });
});

describe("displayInstrumentLabel", () => {
  it("formats OCC symbols and leaves others unchanged", () => {
    expect(displayInstrumentLabel("AAPL260116C00150000")).toBe("AAPL Call 150 $ · 16 jan. 2026");
    expect(displayInstrumentLabel("AAPL")).toBe("AAPL");
    expect(displayInstrumentLabel("BTC/USD")).toBe("BTC/USD");
  });
});

describe("optionMoneyness / isNearTheMoney", () => {
  it("returns the signed distance from spot as a fraction", () => {
    expect(optionMoneyness({ strike: 110 }, 100)).toBeCloseTo(0.1);
    expect(optionMoneyness({ strike: 90 }, 100)).toBeCloseTo(-0.1);
  });

  it("flags strikes within the given fraction of spot", () => {
    expect(isNearTheMoney({ strike: 104 }, 100, 0.05)).toBe(true);
    expect(isNearTheMoney({ strike: 120 }, 100, 0.05)).toBe(false);
  });
});
