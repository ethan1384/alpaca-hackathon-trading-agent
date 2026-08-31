import "server-only";

import { Alpaca } from "@alpacahq/alpaca-trade-api";
import { DEFAULT_STREAM_CHANNELS, TEST_FEED_URL } from "@/config/constants";
import { getEnv } from "@/config/env";
import type { HubConnectionState } from "@/domain/sse-events";
import type { Bar, OrderBook, Quote, StreamChannel, Trade } from "@/domain/types";
import { detectAssetClass } from "@/domain/types";
import {
  normalizeStreamBar,
  normalizeStreamOrderbook,
  normalizeStreamQuote,
  normalizeStreamTrade,
} from "./normalize";

export type StreamMessageHandler = (message: {
  type: "bar" | "quote" | "trade" | "orderbook";
  data: Bar | Quote | Trade | OrderBook;
}) => void;

export type StreamStateHandler = (state: HubConnectionState, message?: string) => void;

export interface AlpacaStreamAdapter {
  connect(): void;
  disconnect(): void;
  subscribe(symbols: readonly string[], channels?: readonly StreamChannel[]): void;
  unsubscribe(symbols: readonly string[], channels?: readonly StreamChannel[]): void;
  onMessage(handler: StreamMessageHandler): () => void;
  onStateChange(handler: StreamStateHandler): () => void;
  getConnectionState(): HubConnectionState;
}

let cachedStreamingClient: Alpaca | null = null;

export function getAlpacaStreamingClient(): Alpaca {
  if (cachedStreamingClient) {
    return cachedStreamingClient;
  }

  const env = getEnv();
  cachedStreamingClient = new Alpaca({
    keyId: env.ALPACA_API_KEY,
    secret: env.ALPACA_API_SECRET,
    paper: env.ALPACA_PAPER,
  });

  return cachedStreamingClient;
}

type StreamMode = "stock" | "crypto";

type AlpacaDataStream = ReturnType<Alpaca["marketData"]["stockStream"]>;

function createStream(mode: StreamMode): AlpacaDataStream {
  const client = getAlpacaStreamingClient();
  const env = getEnv();

  if (mode === "crypto") {
    return client.marketData.cryptoStream();
  }

  if (env.ALPACA_DATA_FEED === "test") {
    return client.marketData.stockStream({ url: TEST_FEED_URL });
  }

  return client.marketData.stockStream({ feed: env.ALPACA_DATA_FEED });
}

function applySubscriptions(
  stream: AlpacaDataStream,
  symbols: readonly string[],
  channels: readonly StreamChannel[],
  action: "subscribe" | "unsubscribe",
): void {
  for (const channel of channels) {
    if (channel === "bars") {
      if (action === "subscribe") {
        stream.subscribeForBars([...symbols]);
      } else {
        stream.unsubscribeFromBars([...symbols]);
      }
    } else if (channel === "quotes") {
      if (action === "subscribe") {
        stream.subscribeForQuotes([...symbols]);
      } else {
        stream.unsubscribeFromQuotes([...symbols]);
      }
    } else if (channel === "trades") {
      if (action === "subscribe") {
        stream.subscribeForTrades([...symbols]);
      } else {
        stream.unsubscribeFromTrades([...symbols]);
      }
    } else if (channel === "orderbook") {
      if (action === "subscribe") {
        stream.subscribeForOrderbooks([...symbols]);
      } else {
        stream.unsubscribeFromOrderbooks([...symbols]);
      }
    }
  }
}

/**
 * The L2 order book channel only exists on the crypto stream. Add it for crypto
 * mode so any crypto symbol gets a book automatically; strip it for stock mode
 * so we never send an `orderbooks` subscription the stock feed would reject.
 */
function resolveChannels(mode: StreamMode, channels: readonly StreamChannel[]): StreamChannel[] {
  const next: StreamChannel[] = channels.filter((channel) => channel !== "orderbook");
  if (mode === "crypto") {
    next.push("orderbook");
  }
  return next;
}

export function createAlpacaStreamAdapter(initialMode: StreamMode = "stock"): AlpacaStreamAdapter {
  let stream = createStream(initialMode);
  let mode = initialMode;
  let connectionState: HubConnectionState = "idle";
  const messageHandlers = new Set<StreamMessageHandler>();
  const stateHandlers = new Set<StreamStateHandler>();
  const activeSymbols = new Set<string>();
  const activeChannels = new Set<StreamChannel>(DEFAULT_STREAM_CHANNELS);

  const emitState = (state: HubConnectionState, message?: string) => {
    connectionState = state;
    for (const handler of stateHandlers) {
      handler(state, message);
    }
  };

  const emitMessage = (payload: Parameters<StreamMessageHandler>[0]) => {
    for (const handler of messageHandlers) {
      handler(payload);
    }
  };

  const attachListeners = () => {
    stream.onConnect(() => {
      emitState("connected");
      if (activeSymbols.size > 0) {
        applySubscriptions(
          stream,
          [...activeSymbols],
          resolveChannels(mode, [...activeChannels]),
          "subscribe",
        );
      }
    });

    stream.onReconnecting(() => {
      emitState("reconnecting");
    });

    stream.onReconnected(() => {
      emitState("connected");
    });

    stream.onDisconnect(() => {
      emitState("disconnected");
    });

    stream.onError((error: string) => {
      emitState("error", error);
    });

    stream.onBar((bar) => {
      emitMessage({ type: "bar", data: normalizeStreamBar(bar) });
    });

    stream.onQuote((quote) => {
      emitMessage({ type: "quote", data: normalizeStreamQuote(quote) });
    });

    stream.onTrade((trade) => {
      emitMessage({ type: "trade", data: normalizeStreamTrade(trade) });
    });

    stream.onOrderbook((orderbook) => {
      emitMessage({ type: "orderbook", data: normalizeStreamOrderbook(orderbook) });
    });
  };

  attachListeners();

  const switchModeIfNeeded = (symbols: readonly string[]): void => {
    const hasCrypto = symbols.some((symbol) => detectAssetClass(symbol) === "crypto");
    const hasStock = symbols.some((symbol) => detectAssetClass(symbol) === "stock");
    if (hasCrypto && hasStock) {
      throw new Error(
        "Cannot mix stock and crypto symbols on a single Alpaca WebSocket connection",
      );
    }

    const nextMode: StreamMode = hasCrypto ? "crypto" : "stock";
    if (nextMode === mode) {
      return;
    }

    stream.disconnect();
    mode = nextMode;
    stream = createStream(mode);
    attachListeners();
    stream.connect();
    emitState("connecting");
  };

  return {
    connect() {
      if (connectionState === "connected" || connectionState === "connecting") {
        return;
      }
      emitState("connecting");
      stream.connect();
    },

    disconnect() {
      stream.disconnect();
      emitState("disconnected");
    },

    subscribe(symbols, channels = DEFAULT_STREAM_CHANNELS) {
      if (symbols.length === 0) {
        return;
      }

      switchModeIfNeeded(symbols);

      for (const channel of channels) {
        activeChannels.add(channel);
      }

      const newSymbols = symbols.filter((symbol) => !activeSymbols.has(symbol));
      for (const symbol of symbols) {
        activeSymbols.add(symbol);
      }

      if (connectionState === "connected" && newSymbols.length > 0) {
        applySubscriptions(stream, newSymbols, resolveChannels(mode, channels), "subscribe");
      }
    },

    unsubscribe(symbols, channels = DEFAULT_STREAM_CHANNELS) {
      const removed: string[] = [];
      for (const symbol of symbols) {
        if (activeSymbols.delete(symbol)) {
          removed.push(symbol);
        }
      }

      if (connectionState === "connected" && removed.length > 0) {
        applySubscriptions(stream, removed, resolveChannels(mode, channels), "unsubscribe");
      }
    },

    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },

    onStateChange(handler) {
      stateHandlers.add(handler);
      handler(connectionState);
      return () => stateHandlers.delete(handler);
    },

    getConnectionState() {
      return connectionState;
    },
  };
}

export function resetAlpacaStreamingClient(): void {
  cachedStreamingClient = null;
}
