import { create } from "zustand";
import type { HubConnectionState } from "@/domain/sse-events";
import type { Bar, OrderBook, Quote, Trade } from "@/domain/types";

export interface SymbolMarketState {
  symbol: string;
  bars: Bar[];
  lastQuote?: Quote;
  lastTrade?: Trade;
  lastOrderBook?: OrderBook;
  lastUpdatedAt?: string;
}

export interface MarketStore {
  connectionState: HubConnectionState;
  subscribedSymbols: string[];
  clock: null;
  bySymbol: Record<string, SymbolMarketState>;

  setConnectionState(state: HubConnectionState): void;
  setSubscribedSymbols(symbols: string[]): void;
  applyBar(bar: Bar): void;
  applyQuote(quote: Quote): void;
  applyTrade(trade: Trade): void;
  applyOrderBook(book: OrderBook): void;
  setHistoricalBars(symbol: string, bars: Bar[]): void;
  removeSymbol(symbol: string): void;
  reset(): void;
}

const MAX_BARS = 500;

function upsertSymbol(
  bySymbol: Record<string, SymbolMarketState>,
  symbol: string,
): SymbolMarketState {
  if (!bySymbol[symbol]) {
    bySymbol[symbol] = { symbol, bars: [] };
  }
  return bySymbol[symbol];
}

export const useMarketStore = create<MarketStore>((set) => ({
  connectionState: "idle",
  subscribedSymbols: [],
  clock: null,
  bySymbol: {},

  setConnectionState: (connectionState) => set({ connectionState }),

  setSubscribedSymbols: (subscribedSymbols) => set({ subscribedSymbols }),

  applyBar: (bar) =>
    set((state) => {
      const bySymbol = { ...state.bySymbol };
      const entry = upsertSymbol(bySymbol, bar.symbol);
      const last = entry.bars.at(-1);
      // Replace the trailing candle when its timestamp matches (live minute
      // updates, e.g. synthesized option bars); otherwise append a new one.
      const bars =
        last && last.timestamp === bar.timestamp
          ? [...entry.bars.slice(0, -1), bar]
          : [...entry.bars, bar];
      entry.bars = bars.length > MAX_BARS ? bars.slice(-MAX_BARS) : bars;
      entry.lastUpdatedAt = bar.timestamp;
      return { bySymbol };
    }),

  applyQuote: (quote) =>
    set((state) => {
      const bySymbol = { ...state.bySymbol };
      const entry = upsertSymbol(bySymbol, quote.symbol);
      entry.lastQuote = quote;
      entry.lastUpdatedAt = quote.timestamp;
      return { bySymbol };
    }),

  applyTrade: (trade) =>
    set((state) => {
      const bySymbol = { ...state.bySymbol };
      const entry = upsertSymbol(bySymbol, trade.symbol);
      entry.lastTrade = trade;
      entry.lastUpdatedAt = trade.timestamp;
      return { bySymbol };
    }),

  applyOrderBook: (book) =>
    set((state) => {
      const bySymbol = { ...state.bySymbol };
      const entry = upsertSymbol(bySymbol, book.symbol);
      entry.lastOrderBook = book;
      entry.lastUpdatedAt = book.timestamp;
      return { bySymbol };
    }),

  setHistoricalBars: (symbol, bars) =>
    set((state) => {
      const bySymbol = { ...state.bySymbol };
      const entry = upsertSymbol(bySymbol, symbol);
      entry.bars = bars.slice(-MAX_BARS);
      entry.lastUpdatedAt = bars.at(-1)?.timestamp;
      return { bySymbol };
    }),

  removeSymbol: (symbol) =>
    set((state) => {
      const bySymbol = { ...state.bySymbol };
      delete bySymbol[symbol];
      return {
        bySymbol,
        subscribedSymbols: state.subscribedSymbols.filter((s) => s !== symbol),
      };
    }),

  reset: () =>
    set({
      connectionState: "idle",
      subscribedSymbols: [],
      bySymbol: {},
    }),
}));
