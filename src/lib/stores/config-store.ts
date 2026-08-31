import { create } from "zustand";
import { DEFAULT_TIMEFRAME } from "@/config/constants";
import type { DataFeed, Timeframe } from "@/domain/types";

export interface ConfigStore {
  symbols: string[];
  timeframe: Timeframe;
  paperMode: boolean;
  dataFeed: DataFeed;
  hydrated: boolean;

  addSymbol(symbol: string): void;
  removeSymbol(symbol: string): void;
  setTimeframe(timeframe: Timeframe): void;
  hydrateFromServer(defaults: { symbols: string[]; paperMode: boolean; dataFeed: DataFeed }): void;
}

export const useConfigStore = create<ConfigStore>((set) => ({
  symbols: [],
  timeframe: DEFAULT_TIMEFRAME,
  paperMode: true,
  dataFeed: "test",
  hydrated: false,

  addSymbol: (symbol) =>
    set((state) => {
      const normalized = symbol.trim().toUpperCase();
      if (!normalized || state.symbols.includes(normalized)) {
        return state;
      }
      return { symbols: [...state.symbols, normalized] };
    }),

  removeSymbol: (symbol) =>
    set((state) => ({
      symbols: state.symbols.filter((s) => s !== symbol),
    })),

  setTimeframe: (timeframe) => set({ timeframe }),

  hydrateFromServer: ({ symbols, paperMode, dataFeed }) =>
    set({
      symbols,
      paperMode,
      dataFeed,
      hydrated: true,
    }),
}));
