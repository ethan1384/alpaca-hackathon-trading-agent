import type { Bar as SdkBar } from "@alpacahq/alpaca-trade-api";
import type { AlpacaRawBar, AlpacaRawQuote, AlpacaRawTrade } from "@/domain/schemas";
import type { Bar, OptionGreeks, OrderBook, Quote, Trade } from "@/domain/types";
import { detectAssetClass } from "@/domain/types";

interface StreamTimestampFields {
  timestamp?: Date;
  timestampRaw?: string;
}

export type StreamBarPayload = {
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
  tradeCount?: number;
} & StreamTimestampFields;

export type StreamQuotePayload = {
  symbol: string;
  bidPrice: number;
  bidSize: number;
  askPrice: number;
  askSize: number;
} & StreamTimestampFields;

export type StreamTradePayload = {
  symbol: string;
  price: number;
  size: number;
  conditions?: string[];
} & StreamTimestampFields;

export type StreamOrderbookPayload = {
  symbol: string;
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
} & StreamTimestampFields;

function timestampToIso(value: Date | string | undefined, fallback?: string): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return fallback ?? new Date().toISOString();
}

/** Like {@link timestampToIso} but yields `undefined` instead of "now" for empty input. */
function timestampToIsoOrUndefined(value: Date | string | undefined): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
}

export function normalizeBar(raw: AlpacaRawBar): Bar {
  return {
    symbol: raw.S,
    assetClass: detectAssetClass(raw.S),
    open: raw.o,
    high: raw.h,
    low: raw.l,
    close: raw.c,
    volume: raw.v,
    vwap: raw.vw,
    tradeCount: raw.n,
    timestamp: raw.t,
  };
}

export function normalizeQuote(raw: AlpacaRawQuote): Quote {
  return {
    symbol: raw.S,
    assetClass: detectAssetClass(raw.S),
    bidPrice: raw.bp,
    bidSize: raw.bs,
    askPrice: raw.ap,
    askSize: raw.as,
    timestamp: raw.t,
  };
}

export function normalizeTrade(raw: AlpacaRawTrade): Trade {
  return {
    symbol: raw.S,
    assetClass: detectAssetClass(raw.S),
    price: raw.p,
    size: raw.s,
    timestamp: raw.t,
    conditions: raw.c,
  };
}

export function normalizeStreamBar(raw: StreamBarPayload): Bar {
  return {
    symbol: raw.symbol,
    assetClass: detectAssetClass(raw.symbol),
    open: raw.open,
    high: raw.high,
    low: raw.low,
    close: raw.close,
    volume: raw.volume,
    vwap: raw.vwap,
    tradeCount: raw.tradeCount,
    timestamp: timestampToIso(raw.timestamp, raw.timestampRaw),
  };
}

export function normalizeStreamQuote(raw: StreamQuotePayload): Quote {
  return {
    symbol: raw.symbol,
    assetClass: detectAssetClass(raw.symbol),
    bidPrice: raw.bidPrice,
    bidSize: raw.bidSize,
    askPrice: raw.askPrice,
    askSize: raw.askSize,
    timestamp: timestampToIso(raw.timestamp, raw.timestampRaw),
  };
}

export function normalizeStreamTrade(raw: StreamTradePayload): Trade {
  return {
    symbol: raw.symbol,
    assetClass: detectAssetClass(raw.symbol),
    price: raw.price,
    size: raw.size,
    timestamp: timestampToIso(raw.timestamp, raw.timestampRaw),
    conditions: raw.conditions,
  };
}

export function normalizeStreamOrderbook(raw: StreamOrderbookPayload): OrderBook {
  return {
    symbol: raw.symbol,
    assetClass: detectAssetClass(raw.symbol),
    bids: [...raw.bids]
      .map((level) => ({ price: level.price, size: level.size }))
      .sort((a, b) => b.price - a.price),
    asks: [...raw.asks]
      .map((level) => ({ price: level.price, size: level.size }))
      .sort((a, b) => a.price - b.price),
    timestamp: timestampToIso(raw.timestamp, raw.timestampRaw),
  };
}

export function normalizeSdkBar(symbol: string, raw: SdkBar): Bar {
  const timestamp =
    raw.timestamp instanceof Date
      ? raw.timestamp.toISOString()
      : (raw.timestampRaw ?? new Date().toISOString());

  return {
    symbol,
    assetClass: detectAssetClass(symbol),
    open: raw.open,
    high: raw.high,
    low: raw.low,
    close: raw.close,
    volume: raw.volume,
    vwap: raw.vwap,
    tradeCount: raw.tradeCount,
    timestamp,
  };
}

// --- Option snapshots ---------------------------------------------------------
// `marketData.collectOptionSnapshotsBySymbol` / `collectOptionChainBySymbol`
// return the *raw generated* snapshot shape with short keys (`ap`, `bp`, `p`,
// `v`, ...). Unlike `getOptionBars`, the SDK wrapper does NOT re-model these, so
// this is the boundary that must know the wire keys (AGENTS.md rule 3).

interface RawOptionQuote {
  ap?: number;
  as?: number;
  bp?: number;
  bs?: number;
  c?: string;
  t?: Date | string;
}

interface RawOptionTrade {
  p?: number;
  s?: number;
  c?: string;
  t?: Date | string;
}

interface RawOptionBar {
  o?: number;
  h?: number;
  l?: number;
  c?: number;
  v?: number;
  vw?: number;
  n?: number;
  t?: Date | string;
}

export interface RawOptionSnapshot {
  latestQuote?: RawOptionQuote;
  latestTrade?: RawOptionTrade;
  dailyBar?: RawOptionBar;
  minuteBar?: RawOptionBar;
  prevDailyBar?: RawOptionBar;
  greeks?: { delta?: number; gamma?: number; theta?: number; vega?: number; rho?: number };
  impliedVolatility?: number;
}

export interface NormalizedOptionSnapshot {
  bid?: number;
  ask?: number;
  last?: number;
  mark?: number;
  volume?: number;
  impliedVolatility?: number;
  greeks?: OptionGreeks;
  updatedAt?: string;
}

export function normalizeOptionSnapshot(
  raw: RawOptionSnapshot | undefined,
): NormalizedOptionSnapshot {
  if (!raw) {
    return {};
  }

  const bid = raw.latestQuote?.bp;
  const ask = raw.latestQuote?.ap;
  const mark =
    typeof bid === "number" && typeof ask === "number" && bid > 0 && ask > 0
      ? (bid + ask) / 2
      : undefined;

  const greeks: OptionGreeks | undefined = raw.greeks
    ? {
        delta: raw.greeks.delta,
        gamma: raw.greeks.gamma,
        theta: raw.greeks.theta,
        vega: raw.greeks.vega,
        rho: raw.greeks.rho,
      }
    : undefined;

  return {
    bid,
    ask,
    last: raw.latestTrade?.p,
    mark,
    volume: raw.dailyBar?.v,
    impliedVolatility: raw.impliedVolatility,
    greeks,
    // The quote timestamp, not the trade's. `updatedAt` is what the [O2] data
    // circuit breaker ages to decide "is this price still real?", and the price
    // it guards is the bid/ask. A far-OTM leg can go 20 minutes without a print
    // while its book is quoted continuously — reading the trade time there
    // condemns a live quote as stale, which blocks the entry and, on an open
    // position, marks it unpriceable and forces a stop it never needed.
    updatedAt: timestampToIsoOrUndefined(
      raw.latestQuote?.t ?? raw.latestTrade?.t ?? raw.dailyBar?.t,
    ),
  };
}
