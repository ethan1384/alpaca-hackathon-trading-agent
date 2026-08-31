import type { DataFeed, StreamChannel, Timeframe } from "@/domain/types";

export const TIMEFRAMES: readonly Timeframe[] = [
  "1Min",
  "5Min",
  "15Min",
  "30Min",
  "1Hour",
  "1Day",
] as const;

export const DEFAULT_TIMEFRAME: Timeframe = "1Min";

export const STREAM_CHANNELS: readonly StreamChannel[] = ["bars", "quotes", "trades"] as const;

export const DEFAULT_STREAM_CHANNELS: readonly StreamChannel[] = STREAM_CHANNELS;

/** Alpaca option data feed. `indicative` is free; `opra` needs a paid subscription. */
export const OPTIONS_FEED = "indicative" as const;

/** The option data stream only carries trades and quotes (no bars channel). */
export const OPTION_STREAM_CHANNELS: readonly StreamChannel[] = ["quotes", "trades"] as const;

export const MAX_SYMBOLS = 10;

export const CHANNELS_PER_SYMBOL = 3;

export const MAX_WS_CHANNELS = 30;

export const COALESCE_MS = 200;

export const HEARTBEAT_INTERVAL_MS = 15_000;

export const TEST_FEED_SYMBOL = "FAKEPACA";

export const TEST_FEED_URL = "wss://stream.data.alpaca.markets/v2/test";

export const DEFAULT_BUFFER_SIZE = 500;

export function parseDefaultSymbols(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

export function resolveDefaultSymbols(symbols: string[], feed: DataFeed): string[] {
  if (feed === "test") {
    return [TEST_FEED_SYMBOL];
  }
  if (symbols.length > 0) {
    return symbols;
  }
  return ["AAPL", "TSLA", "SPY"];
}
