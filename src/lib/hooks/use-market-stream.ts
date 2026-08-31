"use client";

import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import type { StreamEvent } from "@/domain/sse-events";
import { useMarketStore } from "@/lib/stores/market-store";

export function useMarketStream() {
  const {
    applyBar,
    applyQuote,
    applyTrade,
    applyOrderBook,
    setConnectionState,
    setSubscribedSymbols,
  } = useMarketStore(
    useShallow((state) => ({
      applyBar: state.applyBar,
      applyQuote: state.applyQuote,
      applyTrade: state.applyTrade,
      applyOrderBook: state.applyOrderBook,
      setConnectionState: state.setConnectionState,
      setSubscribedSymbols: state.setSubscribedSymbols,
    })),
  );

  useEffect(() => {
    const source = new EventSource("/api/stream");
    let rafId: number | null = null;
    const pending: StreamEvent[] = [];

    const flush = () => {
      rafId = null;
      const batch = pending.splice(0, pending.length);

      for (const event of batch) {
        switch (event.type) {
          case "bar":
            applyBar(event.data);
            break;
          case "quote":
            applyQuote(event.data);
            break;
          case "trade":
            applyTrade(event.data);
            break;
          case "orderbook":
            applyOrderBook(event.data);
            break;
          case "status":
            setConnectionState(event.data.state);
            break;
          case "subscription":
            setSubscribedSymbols([...event.data.symbols]);
            break;
          case "heartbeat":
            break;
        }
      }
    };

    const scheduleFlush = () => {
      if (rafId == null) {
        rafId = requestAnimationFrame(flush);
      }
    };

    const handleEvent = (event: MessageEvent<string>) => {
      if (!event.data) {
        return;
      }

      try {
        const data = JSON.parse(event.data) as StreamEvent["data"];
        const type = (event as MessageEvent & { type?: string }).type ?? "message";
        if (type === "message") {
          return;
        }
        pending.push({ type, data } as StreamEvent);
        scheduleFlush();
      } catch {
        // Ignore malformed SSE payloads
      }
    };

    for (const type of [
      "bar",
      "quote",
      "trade",
      "orderbook",
      "status",
      "subscription",
      "heartbeat",
    ] as const) {
      source.addEventListener(type, handleEvent as EventListener);
    }

    return () => {
      if (rafId != null) {
        cancelAnimationFrame(rafId);
      }
      source.close();
    };
  }, [applyBar, applyQuote, applyTrade, applyOrderBook, setConnectionState, setSubscribedSymbols]);
}
