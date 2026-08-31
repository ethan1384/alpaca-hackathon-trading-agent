"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatOptionLabel, parseOptionSymbol } from "@/domain/types";
import { useBars } from "@/lib/hooks/use-bars";
import { useConfigStore } from "@/lib/stores/config-store";
import { useMarketStore } from "@/lib/stores/market-store";
import { useUiStore } from "@/lib/stores/ui-store";
import { ChangeBadge } from "./ChangeBadge";
import { PriceChart } from "./PriceChart";

interface SymbolCardProps {
  symbol: string;
}

export function SymbolCard({ symbol }: SymbolCardProps) {
  const timeframe = useConfigStore((state) => state.timeframe);
  const market = useMarketStore((state) => state.bySymbol[symbol]);
  const setActiveSymbol = useUiStore((state) => state.setActiveSymbol);

  const option = parseOptionSymbol(symbol);
  const title = option ? formatOptionLabel(option) : symbol;

  useBars(symbol, timeframe, !market || market.bars.length === 0);

  const bars = market?.bars ?? [];
  const lastBar = bars.at(-1);
  const previousBar = bars.at(-2);
  const lastPrice = market?.lastTrade?.price ?? market?.lastQuote?.askPrice ?? lastBar?.close;
  const spread =
    market?.lastQuote != null ? market.lastQuote.askPrice - market.lastQuote.bidPrice : undefined;

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={() => setActiveSymbol(symbol)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setActiveSymbol(symbol);
        }
      }}
      className="cursor-pointer transition hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {lastPrice != null ? lastPrice.toFixed(2) : "—"}
          </p>
        </div>
        <ChangeBadge current={lastBar?.close} previous={previousBar?.close} />
      </CardHeader>
      <CardContent className="space-y-3">
        <PriceChart bars={bars} />
        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <span>Bid: {market?.lastQuote?.bidPrice?.toFixed(2) ?? "—"}</span>
          <span>Ask: {market?.lastQuote?.askPrice?.toFixed(2) ?? "—"}</span>
          <span>Last trade: {market?.lastTrade?.price?.toFixed(2) ?? "—"}</span>
          <span>Spread: {spread != null ? spread.toFixed(2) : "—"}</span>
        </div>
      </CardContent>
    </Card>
  );
}
