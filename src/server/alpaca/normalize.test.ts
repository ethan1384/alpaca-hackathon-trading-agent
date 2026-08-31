import { describe, expect, it } from "vitest";
import {
  normalizeBar,
  normalizeOptionSnapshot,
  normalizeQuote,
  normalizeSdkBar,
  normalizeStreamBar,
  normalizeStreamOrderbook,
  normalizeTrade,
} from "./normalize";

describe("normalizeBar", () => {
  it("maps raw Alpaca keys to domain bar", () => {
    const bar = normalizeBar({
      T: "b",
      S: "AAPL",
      o: 100,
      h: 101,
      l: 99,
      c: 100.5,
      v: 1000,
      t: "2024-07-24T07:56:00Z",
    });

    expect(bar.symbol).toBe("AAPL");
    expect(bar.assetClass).toBe("stock");
    expect(bar.close).toBe(100.5);
  });
});

describe("normalizeQuote", () => {
  it("maps raw quote fields", () => {
    const quote = normalizeQuote({
      T: "q",
      S: "AAPL",
      bp: 100,
      bs: 1,
      ap: 100.1,
      as: 2,
      t: "2024-07-24T07:56:00Z",
    });

    expect(quote.bidPrice).toBe(100);
    expect(quote.askPrice).toBe(100.1);
  });
});

describe("normalizeTrade", () => {
  it("maps raw trade fields", () => {
    const trade = normalizeTrade({
      T: "t",
      S: "BTC/USD",
      p: 50000,
      s: 1,
      t: "2024-07-24T07:56:00Z",
    });

    expect(trade.assetClass).toBe("crypto");
    expect(trade.price).toBe(50000);
  });
});

describe("normalizeStreamBar", () => {
  it("normalizes SDK stream bar timestamps", () => {
    const bar = normalizeStreamBar({
      symbol: "AAPL",
      open: 1,
      high: 2,
      low: 1,
      close: 1.5,
      volume: 10,
      timestamp: new Date("2024-07-24T07:56:00Z"),
    });

    expect(bar.timestamp).toContain("2024-07-24");
  });
});

describe("normalizeStreamOrderbook", () => {
  it("sorts bids descending, asks ascending and normalizes the timestamp", () => {
    const book = normalizeStreamOrderbook({
      symbol: "BTC/USD",
      bids: [
        { price: 49_990, size: 0.5 },
        { price: 50_000, size: 1 },
      ],
      asks: [
        { price: 50_020, size: 2 },
        { price: 50_010, size: 0.25 },
      ],
      timestamp: new Date("2024-07-24T07:56:00Z"),
    });

    expect(book.assetClass).toBe("crypto");
    expect(book.bids.map((l) => l.price)).toEqual([50_000, 49_990]);
    expect(book.asks.map((l) => l.price)).toEqual([50_010, 50_020]);
    expect(book.timestamp).toContain("2024-07-24");
  });
});

describe("normalizeSdkBar", () => {
  it("normalizes REST SDK bars", () => {
    const bar = normalizeSdkBar("AAPL", {
      open: 1,
      high: 2,
      low: 1,
      close: 1.5,
      volume: 10,
      timestamp: new Date("2024-07-24T07:56:00Z"),
    });

    expect(bar.symbol).toBe("AAPL");
    expect(bar.close).toBe(1.5);
  });
});

describe("normalizeOptionSnapshot", () => {
  it("maps short keys, greeks and IV from a full snapshot", () => {
    const snap = normalizeOptionSnapshot({
      latestQuote: { bp: 1.2, ap: 1.4, t: new Date("2026-01-05T14:32:00Z") },
      latestTrade: { p: 1.3, s: 2, t: new Date("2026-01-05T14:33:00Z") },
      dailyBar: { o: 1, h: 1.5, l: 0.9, c: 1.3, v: 500, t: new Date("2026-01-05T00:00:00Z") },
      greeks: { delta: 0.55, gamma: 0.02, theta: -0.03, vega: 0.1, rho: 0.01 },
      impliedVolatility: 0.32,
    });

    expect(snap.bid).toBe(1.2);
    expect(snap.ask).toBe(1.4);
    expect(snap.last).toBe(1.3);
    expect(snap.mark).toBeCloseTo(1.3);
    expect(snap.volume).toBe(500);
    expect(snap.impliedVolatility).toBe(0.32);
    expect(snap.greeks?.delta).toBe(0.55);
    // The QUOTE timestamp, not the trade's — [O2] ages this to decide whether the
    // bid/ask it guards is still real, and a quiet contract can be quoted long
    // after its last print.
    expect(snap.updatedAt).toBe("2026-01-05T14:32:00.000Z");
  });

  it("still yields a last price when the quote is missing", () => {
    const snap = normalizeOptionSnapshot({ latestTrade: { p: 2.1 } });

    expect(snap.bid).toBeUndefined();
    expect(snap.ask).toBeUndefined();
    expect(snap.mark).toBeUndefined();
    expect(snap.last).toBe(2.1);
  });

  it("returns an empty object for an undefined snapshot", () => {
    expect(normalizeOptionSnapshot(undefined)).toEqual({});
  });

  it("does not compute a mark when a side is zero", () => {
    const snap = normalizeOptionSnapshot({ latestQuote: { bp: 0, ap: 1.4 } });

    expect(snap.mark).toBeUndefined();
  });
});
