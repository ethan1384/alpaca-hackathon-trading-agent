import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "./ui-store";

describe("useUiStore", () => {
  beforeEach(() => {
    useUiStore.setState({
      activeSymbol: null,
      optionsSearchOpen: false,
      optionsSearchUnderlying: null,
      dashboardTab: "market",
      ticketIntent: null,
    });
  });

  it("opens and closes the detail view by symbol", () => {
    useUiStore.getState().setActiveSymbol("AAPL");
    expect(useUiStore.getState().activeSymbol).toBe("AAPL");

    useUiStore.getState().setActiveSymbol(null);
    expect(useUiStore.getState().activeSymbol).toBeNull();
  });

  it("switches dashboard tabs", () => {
    useUiStore.getState().setDashboardTab("trading");
    expect(useUiStore.getState().dashboardTab).toBe("trading");
  });

  it("sendToTicket loads the contract, switches to trading, and closes the chain", () => {
    useUiStore.getState().setOptionsSearchOpen(true);
    useUiStore.getState().sendToTicket({
      symbol: "AAPL260116C00150000",
      side: "buy",
      limitPrice: 3.25,
    });

    const state = useUiStore.getState();
    expect(state.ticketIntent).toEqual({
      symbol: "AAPL260116C00150000",
      side: "buy",
      limitPrice: 3.25,
    });
    expect(state.dashboardTab).toBe("trading");
    expect(state.optionsSearchOpen).toBe(false);
  });
});
