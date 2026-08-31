import { describe, expect, it } from "vitest";
import {
  AlpacaRawBarSchema,
  AlpacaRawQuoteSchema,
  AlpacaRawTradeSchema,
  OptionChainQuerySchema,
  SubscriptionRequestSchema,
} from "./schemas";

describe("AlpacaRawBarSchema", () => {
  it("parses a valid bar payload", () => {
    const result = AlpacaRawBarSchema.parse({
      T: "b",
      S: "FAKEPACA",
      o: 132.65,
      h: 136,
      l: 132.12,
      c: 134.65,
      v: 205,
      t: "2024-07-24T07:56:00Z",
      n: 16,
      vw: 133.7,
    });

    expect(result.S).toBe("FAKEPACA");
    expect(result.c).toBe(134.65);
  });
});

describe("AlpacaRawQuoteSchema", () => {
  it("parses a valid quote payload", () => {
    const result = AlpacaRawQuoteSchema.parse({
      T: "q",
      S: "FAKEPACA",
      bp: 133.85,
      bs: 4,
      ap: 135.77,
      as: 5,
      t: "2024-07-24T07:56:53.639713735Z",
    });

    expect(result.ap).toBe(135.77);
  });
});

describe("AlpacaRawTradeSchema", () => {
  it("parses a valid trade payload", () => {
    const result = AlpacaRawTradeSchema.parse({
      T: "t",
      S: "FAKEPACA",
      p: 134.1,
      s: 10,
      t: "2024-07-24T07:56:53.639713735Z",
    });

    expect(result.p).toBe(134.1);
  });
});

describe("SubscriptionRequestSchema", () => {
  it("accepts add/remove actions", () => {
    const result = SubscriptionRequestSchema.parse({
      action: "add",
      symbols: ["AAPL"],
    });

    expect(result.action).toBe("add");
  });
});

describe("OptionChainQuerySchema", () => {
  it("defaults type to 'all' and coerces numeric filters", () => {
    const result = OptionChainQuerySchema.parse({
      underlying: "AAPL",
      expiration: "2026-01-16",
      strikeGte: "100.5",
      moneyness: "0.1",
    });

    expect(result.type).toBe("all");
    expect(result.strikeGte).toBe(100.5);
    expect(result.moneyness).toBe(0.1);
  });

  it("rejects a missing or malformed expiration", () => {
    expect(OptionChainQuerySchema.safeParse({ underlying: "AAPL" }).success).toBe(false);
    expect(
      OptionChainQuerySchema.safeParse({ underlying: "AAPL", expiration: "2026-1-16" }).success,
    ).toBe(false);
  });

  it("rejects a bad underlying and out-of-range moneyness", () => {
    expect(
      OptionChainQuerySchema.safeParse({ underlying: "TOOLONG", expiration: "2026-01-16" }).success,
    ).toBe(false);
    expect(
      OptionChainQuerySchema.safeParse({ underlying: "AA1", expiration: "2026-01-16" }).success,
    ).toBe(false);
    expect(
      OptionChainQuerySchema.safeParse({
        underlying: "AAPL",
        expiration: "2026-01-16",
        moneyness: "2",
      }).success,
    ).toBe(false);
  });
});
