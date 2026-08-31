import "server-only";

import { getEnv } from "@/config/env";
import type { Bar, DataFeed, MarketClock, Timeframe } from "@/domain/types";
import { detectAssetClass, normalizeSymbol } from "@/domain/types";
import { getAlpacaRestClient } from "./client";
import { normalizeSdkBar } from "./normalize";

function toSdkTimeframe(timeframe: Timeframe): string {
  return timeframe;
}

const BAR_MINUTES: Record<Timeframe, number> = {
  "1Min": 1,
  "5Min": 5,
  "15Min": 15,
  "30Min": 30,
  "1Hour": 60,
  "1Day": 60 * 24,
};

/**
 * Alpaca's bars endpoint defaults `start` to the beginning of the current day
 * when omitted, so a raw request only ever returns today's candles. Derive an
 * explicit lookback window wide enough to cover `limit` bars for the timeframe,
 * inflated for the hours the market is closed (equities/options trade ~1/4 of
 * the wall clock; crypto is 24/7). The caller still slices to `limit`.
 */
function lookbackStart(
  timeframe: Timeframe,
  limit: number,
  assetClass: "stock" | "crypto" | "option",
): Date {
  const minutes = BAR_MINUTES[timeframe];
  const closedMarketFactor =
    timeframe === "1Day"
      ? assetClass === "crypto"
        ? 1.1
        : 1.6
      : assetClass === "crypto"
        ? 1.2
        : 4;
  const spanMs = limit * minutes * 60_000 * closedMarketFactor;
  return new Date(Date.now() - spanMs);
}

export async function getHistoricalBars(
  symbol: string,
  timeframe: Timeframe,
  limit: number,
): Promise<Bar[]> {
  const normalized = normalizeSymbol(symbol);
  const assetClass = detectAssetClass(normalized);
  const client = getAlpacaRestClient();
  const sdkTimeframe = toSdkTimeframe(timeframe);
  const start = lookbackStart(timeframe, limit, assetClass);

  if (assetClass === "crypto") {
    const response = await client.marketData.getCryptoBars({
      symbols: [normalized],
      timeframe: sdkTimeframe as never,
      start,
      limit,
      loc: "us",
    });

    const bars = response[normalized] ?? [];
    return bars.map((bar) => normalizeSdkBar(normalized, bar)).slice(-limit);
  }

  if (assetClass === "option") {
    const response = await client.marketData.getOptionBars({
      symbols: [normalized],
      timeframe: sdkTimeframe as never,
      start,
      limit,
    });

    const bars = response[normalized] ?? [];
    return bars.map((bar) => normalizeSdkBar(normalized, bar)).slice(-limit);
  }

  const envFeed = getEnv().ALPACA_DATA_FEED;
  const feed = envFeed === "test" ? "iex" : envFeed;

  const response = await client.marketData.getStockBars({
    symbols: [normalized],
    timeframe: sdkTimeframe as never,
    start,
    limit,
    feed,
  });

  const bars = response[normalized] ?? [];
  return bars.map((bar) => normalizeSdkBar(normalized, bar)).slice(-limit);
}

/**
 * Historical bars over an explicit date range.
 *
 * `getHistoricalBars` answers "the last N bars", deriving its own `start` from
 * the wall clock, which cannot express a past window. A backtest needs exactly
 * that, so this is the range-addressed variant. The SDK follows the page-token
 * chain itself; `maxPerSymbol` bounds an accidental request for years of
 * minute bars.
 */
/** `YYYY-MM-DD` widens to the whole UTC day; anything else is parsed as-is. */
function toRangeBound(value: string, edge: "start" | "end"): Date {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  return new Date(dateOnly ? `${value}T${edge === "start" ? "00:00:00" : "23:59:59"}Z` : value);
}

/**
 * Historical bars over an explicit date range.
 *
 * `getHistoricalBars` answers "the last N bars", deriving its own `start` from
 * the wall clock, which cannot express a past window. A backtest needs exactly
 * that, so this is the range-addressed variant. The SDK follows the page-token
 * chain itself; `maxPerSymbol` bounds an accidental request for years of
 * minute bars.
 */
export async function getBarsRange(
  symbol: string,
  timeframe: Timeframe,
  start: string,
  end: string,
  maxPerSymbol = 50_000,
  feedOverride?: DataFeed,
): Promise<Bar[]> {
  const normalized = normalizeSymbol(symbol);
  const assetClass = detectAssetClass(normalized);
  const client = getAlpacaRestClient();
  const req = {
    symbols: [normalized],
    timeframe: toSdkTimeframe(timeframe) as never,
    start: toRangeBound(start, "start"),
    end: toRangeBound(end, "end"),
  };
  const opts = { maxPerSymbol };

  if (assetClass === "crypto") {
    const response = await client.marketData.getCryptoBars({ ...req, loc: "us" }, opts);
    return (response[normalized] ?? []).map((bar) => normalizeSdkBar(normalized, bar));
  }

  if (assetClass === "option") {
    const response = await client.marketData.getOptionBars(req, opts);
    return (response[normalized] ?? []).map((bar) => normalizeSdkBar(normalized, bar));
  }

  const envFeed = feedOverride ?? getEnv().ALPACA_DATA_FEED;
  const feed = envFeed === "test" ? "iex" : envFeed;
  const response = await client.marketData.getStockBars({ ...req, feed }, opts);
  return (response[normalized] ?? []).map((bar) => normalizeSdkBar(normalized, bar));
}

export async function getMarketClock(): Promise<MarketClock> {
  const client = getAlpacaRestClient();
  const clock = await client.trading.clock.legacyClock();

  return {
    isOpen: clock.isOpen,
    timestamp: clock.timestamp.toISOString(),
    nextOpen: clock.nextOpen.toISOString(),
    nextClose: clock.nextClose.toISOString(),
  };
}
