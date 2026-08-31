"use client";

import { useEffect } from "react";
import { AgentPanel } from "@/components/agent/AgentPanel";
import { BacktestWorkspace } from "@/components/backtest/BacktestWorkspace";
import { ConfigPanel } from "@/components/config-panel/ConfigPanel";
import { MarketStatusBadge } from "@/components/dashboard/MarketStatusBadge";
import { SymbolDetailDialog } from "@/components/dashboard/SymbolDetailDialog";
import { SymbolGrid } from "@/components/dashboard/SymbolGrid";
import { OptionChainDialog } from "@/components/options/OptionChainDialog";
import { TradingPanel } from "@/components/trading/TradingPanel";
import { Separator } from "@/components/ui/separator";
import { useClock } from "@/lib/hooks/use-clock";
import { useMarketStream } from "@/lib/hooks/use-market-stream";
import { useConfigStore } from "@/lib/stores/config-store";
import { useMarketStore } from "@/lib/stores/market-store";
import { useUiStore } from "@/lib/stores/ui-store";
import { cn } from "@/lib/utils";

export function Dashboard() {
  useMarketStream();

  const { data: clock } = useClock();
  const connectionState = useMarketStore((state) => state.connectionState);
  const hydrateFromServer = useConfigStore((state) => state.hydrateFromServer);
  const hydrated = useConfigStore((state) => state.hydrated);
  const tab = useUiStore((state) => state.dashboardTab);
  const setTab = useUiStore((state) => state.setDashboardTab);

  useEffect(() => {
    if (clock && !hydrated) {
      const envSymbols =
        process.env.NEXT_PUBLIC_DEFAULT_SYMBOLS?.split(",")
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean) ?? [];

      const symbols =
        clock.feed === "test"
          ? ["FAKEPACA"]
          : envSymbols.length > 0
            ? envSymbols
            : ["AAPL", "TSLA", "SPY"];

      hydrateFromServer({
        symbols,
        paperMode: clock.paper,
        dataFeed: clock.feed,
      });
    }
  }, [clock, hydrated, hydrateFromServer]);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Alpaca Market Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Real-time market data via server-side Alpaca hub and SSE fan-out.
          </p>
        </div>
        <MarketStatusBadge clock={clock} connectionState={connectionState} />
      </header>

      <div className="flex gap-1 rounded-md border border-input p-1 self-start">
        {(["market", "trading", "backtest", "agent"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn(
              "rounded px-3 py-1.5 text-sm font-medium capitalize transition-colors",
              tab === t ? "bg-primary text-primary-foreground" : "hover:bg-accent",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      <Separator />

      {tab === "market" ? (
        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <ConfigPanel />
          <SymbolGrid />
        </div>
      ) : tab === "trading" ? (
        <TradingPanel />
      ) : tab === "backtest" ? (
        <BacktestWorkspace />
      ) : (
        <AgentPanel />
      )}

      <SymbolDetailDialog />
      <OptionChainDialog />
    </div>
  );
}
