// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { OptionQuoteRow } from "@/domain/types";
import { useConfigStore } from "@/lib/stores/config-store";
import { useUiStore } from "@/lib/stores/ui-store";
import { OptionChainTable } from "./OptionChainTable";

function row(strike: number, iv: number | undefined): OptionQuoteRow {
  return {
    symbol: `AAPL260116C00${String(strike * 1000).padStart(6, "0")}`,
    underlying: "AAPL",
    expiration: "2026-01-16",
    type: "call",
    strike,
    impliedVolatility: iv,
  };
}

const rows = [row(150, 0.2), row(140, undefined), row(160, 0.3)];

function strikeColumn(container: HTMLElement): string[] {
  return [...container.querySelectorAll("tbody tr td:first-child")].map(
    (cell) => cell.textContent ?? "",
  );
}

describe("OptionChainTable", () => {
  beforeEach(() => {
    useConfigStore.setState({ symbols: [] });
    useUiStore.setState({
      ticketIntent: null,
      dashboardTab: "market",
      optionsSearchOpen: true,
    });
  });

  it("sorts by strike ascending by default", () => {
    const { container } = render(<OptionChainTable rows={rows} loading={false} error={null} />);
    expect(strikeColumn(container)).toEqual(["140.00", "150.00", "160.00"]);
  });

  it("flips strike order when the header is clicked", () => {
    const { container } = render(<OptionChainTable rows={rows} loading={false} error={null} />);
    const strikeHeader = container.querySelector("thead button") as HTMLButtonElement;
    fireEvent.click(strikeHeader);
    expect(strikeColumn(container)).toEqual(["160.00", "150.00", "140.00"]);
  });

  it("keeps rows with a missing sort value last", () => {
    const { container } = render(<OptionChainTable rows={rows} loading={false} error={null} />);
    const ivHeader = [...container.querySelectorAll("thead button")].find((b) =>
      b.textContent?.startsWith("VI"),
    ) as HTMLButtonElement;
    fireEvent.click(ivHeader);
    // asc by IV: 150 (0.2), 160 (0.3), then 140 (undefined) last
    expect(strikeColumn(container)).toEqual(["150.00", "160.00", "140.00"]);
  });

  it("sends the contract to the order ticket on Acheter", () => {
    const withAsk: OptionQuoteRow[] = [{ ...row(150, 0.2), ask: 3.25 }];
    const { getByRole } = render(<OptionChainTable rows={withAsk} loading={false} error={null} />);
    fireEvent.click(getByRole("button", { name: "Acheter" }));

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
