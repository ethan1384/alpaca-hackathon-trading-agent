import "server-only";

import {
  COALESCE_MS,
  DEFAULT_STREAM_CHANNELS,
  MAX_SYMBOLS,
  OPTION_STREAM_CHANNELS,
  resolveDefaultSymbols,
} from "@/config/constants";
import { getEnv } from "@/config/env";
import type { HubConnectionState, StreamEvent } from "@/domain/sse-events";
import type { Bar, StreamChannel, Trade } from "@/domain/types";
import { detectAssetClass, normalizeSymbol } from "@/domain/types";
import { createAlpacaOptionStreamAdapter } from "@/server/alpaca/option-stream";
import { type AlpacaStreamAdapter, createAlpacaStreamAdapter } from "@/server/alpaca/stream";
import { createOptionBarAggregator } from "./bar-aggregator";
import { EventCoalescer } from "./coalesce";
import { RingBuffer } from "./ring-buffer";

const CONNECTION_PRIORITY: Record<HubConnectionState, number> = {
  error: 5,
  reconnecting: 4,
  connecting: 3,
  disconnected: 2,
  connected: 1,
  idle: 0,
};

function mergeConnectionState(a: HubConnectionState, b: HubConnectionState): HubConnectionState {
  return CONNECTION_PRIORITY[a] >= CONNECTION_PRIORITY[b] ? a : b;
}

export type UnsubscribeFn = () => void;

export interface MarketHubStats {
  connectionState: HubConnectionState;
  subscribedSymbols: readonly string[];
  clientCount: number;
  bufferSize: number;
}

export interface MarketHub {
  getConnectionState(): HubConnectionState;
  getSubscribedSymbols(): readonly string[];
  getBars(symbol: string): readonly Bar[];
  subscribe(symbols: readonly string[], channels?: readonly StreamChannel[]): Promise<void>;
  unsubscribe(symbols: readonly string[]): Promise<void>;
  addClient(listener: (event: StreamEvent) => void): UnsubscribeFn;
  ensureStarted(): Promise<void>;
  stop(): Promise<void>;
  getStats(): MarketHubStats;
}

export interface MarketHubDeps {
  bufferSize?: number;
  coalesceMs?: number;
  channels?: readonly StreamChannel[];
  stream?: AlpacaStreamAdapter;
  optionStream?: AlpacaStreamAdapter;
}

const isOptionSymbol = (symbol: string) => detectAssetClass(symbol) === "option";

export function createMarketHub(deps: MarketHubDeps = {}): MarketHub {
  const env = getEnv();
  const bufferSize = deps.bufferSize ?? env.MARKET_BUFFER_SIZE;
  const coalesceMs = deps.coalesceMs ?? COALESCE_MS;
  const channels = deps.channels ?? DEFAULT_STREAM_CHANNELS;

  const stream = deps.stream ?? createAlpacaStreamAdapter();
  const optionStream = deps.optionStream ?? createAlpacaOptionStreamAdapter();
  const optionAggregator = createOptionBarAggregator();
  const barBuffers = new Map<string, RingBuffer<Bar>>();
  const refCounts = new Map<string, number>();
  const clients = new Set<(event: StreamEvent) => void>();
  let started = false;
  let equityState: HubConnectionState = "idle";
  let optionState: HubConnectionState = "idle";

  const hasOptions = () => [...refCounts.keys()].some(isOptionSymbol);

  const connectionState = (): HubConnectionState =>
    hasOptions() ? mergeConnectionState(equityState, optionState) : equityState;

  const getOrCreateBuffer = (symbol: string): RingBuffer<Bar> => {
    let buffer = barBuffers.get(symbol);
    if (!buffer) {
      buffer = new RingBuffer<Bar>(bufferSize);
      barBuffers.set(symbol, buffer);
    }
    return buffer;
  };

  const broadcast = (event: StreamEvent) => {
    for (const client of clients) {
      client(event);
    }
  };

  const coalescer = new EventCoalescer(coalesceMs, (events) => {
    for (const event of events) {
      broadcast(event);
    }
  });

  const handleStreamMessage = (message: {
    type: "bar" | "quote" | "trade" | "orderbook";
    data: Bar | { symbol: string };
  }) => {
    if (message.type === "bar") {
      const bar = message.data as Bar;
      getOrCreateBuffer(bar.symbol).push(bar);
    }

    coalescer.push(message as StreamEvent);

    // The option stream has no bars channel: synthesize 1-minute candles from trades.
    if (message.type === "trade" && isOptionSymbol(message.data.symbol)) {
      const trade = message.data as Trade;
      const bar = optionAggregator.push(trade);
      coalescer.push({ type: "bar", data: bar });
    }
  };

  const emitMergedStatus = (message?: string) => {
    broadcast({ type: "status", data: { state: connectionState(), message } });
  };

  stream.onMessage(handleStreamMessage);
  stream.onStateChange((state, message) => {
    equityState = state;
    emitMergedStatus(message);
  });

  optionStream.onMessage(handleStreamMessage);
  optionStream.onStateChange((state, message) => {
    optionState = state;
    emitMergedStatus(message);
  });

  const seedDefaults = async () => {
    const defaults = resolveDefaultSymbols(env.defaultSymbols, env.ALPACA_DATA_FEED);
    await subscribeInternal(defaults, channels);
  };

  const subscribeInternal = async (
    symbols: readonly string[],
    nextChannels: readonly StreamChannel[],
  ) => {
    const normalized = symbols.map(normalizeSymbol);
    const unique = normalized.filter((symbol) => !refCounts.has(symbol));

    if (refCounts.size + unique.length > MAX_SYMBOLS) {
      throw new Error(`Symbol limit exceeded (${MAX_SYMBOLS} max, 3 channels each)`);
    }

    for (const symbol of normalized) {
      refCounts.set(symbol, (refCounts.get(symbol) ?? 0) + 1);
    }

    if (unique.length > 0) {
      const equityUnique = unique.filter((symbol) => !isOptionSymbol(symbol));
      const optionUnique = unique.filter(isOptionSymbol);

      if (equityUnique.length > 0) {
        stream.subscribe(equityUnique, nextChannels);
      }
      if (optionUnique.length > 0) {
        optionStream.connect();
        optionStream.subscribe(optionUnique, OPTION_STREAM_CHANNELS);
      }

      broadcast({
        type: "subscription",
        data: { symbols: [...refCounts.keys()], channels: [...nextChannels] },
      });
    }
  };

  const unsubscribeInternal = async (symbols: readonly string[]) => {
    const removed: string[] = [];

    for (const symbol of symbols.map(normalizeSymbol)) {
      const count = refCounts.get(symbol);
      if (!count) {
        continue;
      }

      if (count <= 1) {
        refCounts.delete(symbol);
        removed.push(symbol);
      } else {
        refCounts.set(symbol, count - 1);
      }
    }

    if (removed.length > 0) {
      const equityRemoved = removed.filter((symbol) => !isOptionSymbol(symbol));
      const optionRemoved = removed.filter(isOptionSymbol);

      if (equityRemoved.length > 0) {
        stream.unsubscribe(equityRemoved, channels);
      }
      for (const symbol of optionRemoved) {
        optionAggregator.reset(symbol);
      }
      if (optionRemoved.length > 0) {
        optionStream.unsubscribe(optionRemoved, OPTION_STREAM_CHANNELS);
      }

      broadcast({
        type: "subscription",
        data: { symbols: [...refCounts.keys()], channels: [...channels] },
      });
    }

    if (!hasOptions() && optionState !== "idle" && optionState !== "disconnected") {
      optionStream.disconnect();
    }

    if (refCounts.size === 0) {
      stream.disconnect();
      started = false;
    }
  };

  return {
    getConnectionState() {
      return connectionState();
    },

    getSubscribedSymbols() {
      return [...refCounts.keys()];
    },

    getBars(symbol: string) {
      return getOrCreateBuffer(normalizeSymbol(symbol)).toArray();
    },

    async subscribe(symbols, nextChannels = channels) {
      await subscribeInternal(symbols, nextChannels);
      if (!started) {
        await this.ensureStarted();
      }
    },

    async unsubscribe(symbols) {
      await unsubscribeInternal(symbols);
    },

    addClient(listener) {
      clients.add(listener);
      listener({
        type: "status",
        data: { state: connectionState() },
      });
      listener({
        type: "subscription",
        data: { symbols: [...refCounts.keys()], channels: [...channels] },
      });

      return () => {
        clients.delete(listener);
      };
    },

    async ensureStarted() {
      if (started) {
        return;
      }

      started = true;
      stream.connect();

      if (refCounts.size === 0) {
        await seedDefaults();
      }
    },

    async stop() {
      coalescer.dispose();
      stream.disconnect();
      optionStream.disconnect();
      clients.clear();
      refCounts.clear();
      barBuffers.clear();
      started = false;
    },

    getStats() {
      return {
        connectionState: connectionState(),
        subscribedSymbols: [...refCounts.keys()],
        clientCount: clients.size,
        bufferSize,
      };
    },
  };
}

export function getMarketHub(): MarketHub {
  if (!globalThis.__marketHub) {
    globalThis.__marketHub = createMarketHub();
  }
  return globalThis.__marketHub;
}
