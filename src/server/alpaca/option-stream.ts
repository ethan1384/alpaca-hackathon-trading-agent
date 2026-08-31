import "server-only";

import { OPTION_STREAM_CHANNELS, OPTIONS_FEED } from "@/config/constants";
import type { HubConnectionState } from "@/domain/sse-events";
import type { StreamChannel } from "@/domain/types";
import { normalizeStreamQuote, normalizeStreamTrade } from "./normalize";
import type { AlpacaStreamAdapter, StreamMessageHandler, StreamStateHandler } from "./stream";
import { getAlpacaStreamingClient } from "./stream";

type OptionDataStream = ReturnType<
  ReturnType<typeof getAlpacaStreamingClient>["marketData"]["optionStream"]
>;

function createOptionStream(): OptionDataStream {
  return getAlpacaStreamingClient().marketData.optionStream({ feed: OPTIONS_FEED });
}

/**
 * Adapter for Alpaca's option data stream. Runs on a separate WebSocket from the
 * equity/crypto stream and only carries `trades` and `quotes` (no bars channel).
 */
export function createAlpacaOptionStreamAdapter(): AlpacaStreamAdapter {
  const stream = createOptionStream();
  let connectionState: HubConnectionState = "idle";
  const messageHandlers = new Set<StreamMessageHandler>();
  const stateHandlers = new Set<StreamStateHandler>();
  const activeSymbols = new Set<string>();

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

  const applySubscriptions = (symbols: readonly string[], action: "subscribe" | "unsubscribe") => {
    if (symbols.length === 0) {
      return;
    }
    const list = [...symbols];
    if (action === "subscribe") {
      stream.subscribeForTrades(list);
      stream.subscribeForQuotes(list);
    } else {
      stream.unsubscribeFromTrades(list);
      stream.unsubscribeFromQuotes(list);
    }
  };

  stream.onConnect(() => {
    emitState("connected");
    if (activeSymbols.size > 0) {
      applySubscriptions([...activeSymbols], "subscribe");
    }
  });
  stream.onReconnecting(() => emitState("reconnecting"));
  stream.onReconnected(() => emitState("connected"));
  stream.onDisconnect(() => emitState("disconnected"));
  stream.onError((error: string) => emitState("error", error));

  stream.onTrade((trade) => {
    emitMessage({ type: "trade", data: normalizeStreamTrade(trade) });
  });
  stream.onQuote((quote) => {
    emitMessage({ type: "quote", data: normalizeStreamQuote(quote) });
  });

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

    subscribe(symbols, _channels: readonly StreamChannel[] = OPTION_STREAM_CHANNELS) {
      const newSymbols = symbols.filter((symbol) => !activeSymbols.has(symbol));
      for (const symbol of symbols) {
        activeSymbols.add(symbol);
      }
      if (connectionState === "connected" && newSymbols.length > 0) {
        applySubscriptions(newSymbols, "subscribe");
      }
    },

    unsubscribe(symbols, _channels: readonly StreamChannel[] = OPTION_STREAM_CHANNELS) {
      const removed: string[] = [];
      for (const symbol of symbols) {
        if (activeSymbols.delete(symbol)) {
          removed.push(symbol);
        }
      }
      if (connectionState === "connected" && removed.length > 0) {
        applySubscriptions(removed, "unsubscribe");
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
