import type { Bar, Trade } from "@/domain/types";

/** Truncate an ISO timestamp down to the start of its minute. */
export function minuteBucket(iso: string): string {
  const date = new Date(iso);
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

export interface OptionBarAggregator {
  /** Fold a trade into the running minute bar for its symbol and return a snapshot. */
  push(trade: Pick<Trade, "symbol" | "price" | "size" | "timestamp">): Bar;
  reset(symbol: string): void;
}

/**
 * The option data stream has no bars channel, so we synthesize 1-minute candles
 * from the trade stream. Each `push` returns a fresh copy of the current candle;
 * the client store replaces the last candle when the timestamp matches.
 */
export function createOptionBarAggregator(): OptionBarAggregator {
  const current = new Map<string, Bar>();

  return {
    push(trade) {
      const bucket = minuteBucket(trade.timestamp);
      const existing = current.get(trade.symbol);

      if (existing && existing.timestamp === bucket) {
        existing.high = Math.max(existing.high, trade.price);
        existing.low = Math.min(existing.low, trade.price);
        existing.close = trade.price;
        existing.volume += trade.size;
        existing.tradeCount = (existing.tradeCount ?? 0) + 1;
        return { ...existing };
      }

      const bar: Bar = {
        symbol: trade.symbol,
        assetClass: "option",
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: trade.size,
        tradeCount: 1,
        timestamp: bucket,
      };
      current.set(trade.symbol, bar);
      return { ...bar };
    },

    reset(symbol) {
      current.delete(symbol);
    },
  };
}
