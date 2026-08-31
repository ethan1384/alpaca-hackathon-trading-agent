"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TIMEFRAMES } from "@/config/constants";
import type { Timeframe } from "@/domain/types";
import { formatOptionLabel, parseOptionSymbol } from "@/domain/types";
import { fetchBars } from "@/lib/api/bars";
import { mergeTrailingBars } from "@/lib/bars-merge";
import { useConfigStore } from "@/lib/stores/config-store";
import { useMarketStore } from "@/lib/stores/market-store";
import { useUiStore } from "@/lib/stores/ui-store";
import { ChangeBadge } from "./ChangeBadge";
import { OrderBookLadder } from "./OrderBookLadder";
import { PriceChart } from "./PriceChart";

export function SymbolDetailDialog() {
  const activeSymbol = useUiStore((state) => state.activeSymbol);
  const setActiveSymbol = useUiStore((state) => state.setActiveSymbol);

  return (
    <Dialog
      open={activeSymbol != null}
      onOpenChange={(open) => {
        if (!open) {
          setActiveSymbol(null);
        }
      }}
    >
      {activeSymbol != null && (
        <DialogContent className="flex h-[90vh] w-[95vw] max-w-[95vw] flex-col gap-4 overflow-hidden">
          <SymbolDetailBody symbol={activeSymbol} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function num(value: number | undefined, digits = 2): string {
  return value == null ? "—" : value.toFixed(digits);
}

function SymbolDetailBody({ symbol }: { symbol: string }) {
  const configTimeframe = useConfigStore((state) => state.timeframe);
  const [timeframe, setTimeframe] = useState<Timeframe>(configTimeframe);
  const market = useMarketStore((state) => state.bySymbol[symbol]);

  const option = parseOptionSymbol(symbol);
  const title = option ? formatOptionLabel(option) : symbol;

  const historyQuery = useQuery({
    queryKey: ["detail-bars", symbol, timeframe],
    queryFn: () => fetchBars(symbol, timeframe, 2000),
    enabled: symbol.length > 0,
  });

  const bars = useMemo(() => {
    const base = historyQuery.data?.bars ?? [];
    if (timeframe !== "1Min" || !market?.bars.length) {
      return base;
    }
    return mergeTrailingBars(base, market.bars);
  }, [historyQuery.data, market?.bars, timeframe]);

  const lastBar = bars.at(-1);
  const previousBar = bars.at(-2);
  const lastPrice = market?.lastTrade?.price ?? market?.lastQuote?.askPrice ?? lastBar?.close;
  const spread =
    market?.lastQuote != null ? market.lastQuote.askPrice - market.lastQuote.bidPrice : undefined;
  const sessionHigh = bars.length ? Math.max(...bars.map((b) => b.high)) : undefined;
  const sessionLow = bars.length ? Math.min(...bars.map((b) => b.low)) : undefined;
  const windowVolume = bars.reduce((sum, b) => sum + b.volume, 0);

  const subtitle = option
    ? `${option.underlying} · ${option.strike} ${option.type === "call" ? "Call" : "Put"} · exp. ${option.expiration}`
    : (historyQuery.data?.assetClass ?? "stock");

  return (
    <>
      <DialogHeader>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 pr-8">
          <DialogTitle className="text-xl">{title}</DialogTitle>
          <span className="text-2xl font-semibold tabular-nums">{num(lastPrice)}</span>
          <ChangeBadge current={lastBar?.close} previous={previousBar?.close} />
        </div>
        <DialogDescription className="uppercase tracking-wide">{subtitle}</DialogDescription>
      </DialogHeader>

      <div className="flex flex-wrap gap-1">
        {TIMEFRAMES.map((item) => (
          <Button
            key={item}
            type="button"
            size="sm"
            variant={item === timeframe ? "default" : "outline"}
            onClick={() => setTimeframe(item)}
          >
            {item}
          </Button>
        ))}
      </div>

      <div className="flex min-h-[300px] flex-1 gap-4 overflow-hidden">
        <div className="flex flex-1 items-center justify-center">
          {historyQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Chargement des bougies…</p>
          ) : bars.length === 0 ? (
            <p className="max-w-sm text-center text-sm text-muted-foreground">
              Aucune bougie disponible pour ce symbole
              {option ? " (l'historique d'options nécessite l'abonnement OPRA)" : ""}.
            </p>
          ) : (
            <div className="w-full">
              <PriceChart
                bars={bars}
                height={440}
                showVolume
                showLegend
                intraday={timeframe !== "1Day"}
              />
            </div>
          )}
        </div>
        <div className="hidden w-[300px] shrink-0 overflow-y-auto lg:block">
          <OrderBookLadder symbol={symbol} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm text-muted-foreground sm:grid-cols-4">
        <Stat label="Bid" value={num(market?.lastQuote?.bidPrice)} />
        <Stat label="Ask" value={num(market?.lastQuote?.askPrice)} />
        <Stat label="Spread" value={num(spread)} />
        <Stat label="Last trade" value={num(market?.lastTrade?.price)} />
        <Stat label="Plus haut" value={num(sessionHigh)} />
        <Stat label="Plus bas" value={num(sessionLow)} />
        <Stat label="VWAP" value={num(lastBar?.vwap)} />
        <Stat label="Volume (fenêtre)" value={windowVolume ? windowVolume.toLocaleString() : "—"} />
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs">{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  );
}
