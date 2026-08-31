import { create } from "zustand";

export type DashboardTab = "market" | "trading" | "backtest" | "agent";

/** Contract the order ticket should load (from the chain, a position, or the watchlist). */
export interface TicketIntent {
  symbol: string;
  side: "buy" | "sell";
  /** When set (typically bid/ask from the chain), the ticket switches to a limit order. */
  limitPrice?: number;
}

export interface UiStore {
  /** Symbol whose detail view ("TradingView") dialog is open, or `null` when closed. */
  activeSymbol: string | null;
  setActiveSymbol(symbol: string | null): void;

  /** Whether the option-search dialog is open. */
  optionsSearchOpen: boolean;
  setOptionsSearchOpen(open: boolean): void;

  /** Prefill the option-chain underlying when the dialog opens. Consumed on open. */
  optionsSearchUnderlying: string | null;
  setOptionsSearchUnderlying(underlying: string | null): void;

  dashboardTab: DashboardTab;
  setDashboardTab(tab: DashboardTab): void;

  ticketIntent: TicketIntent | null;
  setTicketIntent(intent: TicketIntent | null): void;
  /** Load a contract into the ticket, switch to Trading, and close the option-search dialog. */
  sendToTicket(intent: TicketIntent): void;
}

export const useUiStore = create<UiStore>((set) => ({
  activeSymbol: null,
  setActiveSymbol: (activeSymbol) => set({ activeSymbol }),

  optionsSearchOpen: false,
  setOptionsSearchOpen: (optionsSearchOpen) => set({ optionsSearchOpen }),

  optionsSearchUnderlying: null,
  setOptionsSearchUnderlying: (optionsSearchUnderlying) => set({ optionsSearchUnderlying }),

  dashboardTab: "market",
  setDashboardTab: (dashboardTab) => set({ dashboardTab }),

  ticketIntent: null,
  setTicketIntent: (ticketIntent) => set({ ticketIntent }),
  sendToTicket: (ticketIntent) =>
    set({
      ticketIntent,
      dashboardTab: "trading",
      optionsSearchOpen: false,
    }),
}));
