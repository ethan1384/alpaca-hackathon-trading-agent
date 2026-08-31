"use client";

import { useMemo } from "react";
import type { OrderBookLevel } from "@/domain/types";
import { detectAssetClass } from "@/domain/types";
import { useMarketStore } from "@/lib/stores/market-store";
import { cn } from "@/lib/utils";

/** Number of price levels rendered per side. */
const DEPTH = 12;

interface OrderBookLadderProps {
  symbol: string;
}

function formatPrice(value: number): string {
  const digits = value >= 100 ? 2 : value >= 1 ? 4 : 6;
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatSize(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

interface Row {
  price: number;
  size: number;
  /** Running total from the best price outwards. */
  cumulative: number;
}

function buildRows(levels: OrderBookLevel[]): Row[] {
  const rows: Row[] = [];
  let cumulative = 0;
  for (const level of levels.slice(0, DEPTH)) {
    cumulative += level.size;
    rows.push({ price: level.price, size: level.size, cumulative });
  }
  return rows;
}

export function OrderBookLadder({ symbol }: OrderBookLadderProps) {
  const book = useMarketStore((state) => state.bySymbol[symbol]?.lastOrderBook);

  const { bids, asks, maxCumulative, spread, mid } = useMemo(() => {
    const bidRows = buildRows(book?.bids ?? []);
    const askRows = buildRows(book?.asks ?? []);
    const max = Math.max(bidRows.at(-1)?.cumulative ?? 0, askRows.at(-1)?.cumulative ?? 0, 1);
    const bestBid = bidRows[0]?.price;
    const bestAsk = askRows[0]?.price;
    return {
      bids: bidRows,
      asks: askRows,
      maxCumulative: max,
      spread: bestBid != null && bestAsk != null ? bestAsk - bestBid : undefined,
      mid: bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : undefined,
    };
  }, [book]);

  if (detectAssetClass(symbol) !== "crypto") {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        Carnet d'ordres L2 disponible uniquement pour le crypto (ex.&nbsp;BTC/USD).
      </div>
    );
  }

  if (!book || (bids.length === 0 && asks.length === 0)) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        En attente du carnet d'ordres…
      </div>
    );
  }

  return (
    <div className="flex flex-col rounded-lg border text-xs">
      <div className="flex items-center justify-between border-b px-3 py-2 text-muted-foreground">
        <span className="font-medium text-foreground">Carnet d'ordres</span>
        <span className="tabular-nums">
          {DEPTH} niveaux · {book.symbol}
        </span>
      </div>

      <div className="grid grid-cols-[1fr_1fr_1fr] gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>Prix</span>
        <span className="text-right">Taille</span>
        <span className="text-right">Cumul</span>
      </div>

      {/* Asks: worst price on top, best ask just above the spread row. */}
      <div className="flex flex-col-reverse">
        {asks.map((row) => (
          <LadderRow key={`ask-${row.price}`} row={row} side="ask" maxCumulative={maxCumulative} />
        ))}
      </div>

      <div className="flex items-center justify-between border-y bg-muted/40 px-3 py-1.5 tabular-nums">
        <span className="text-muted-foreground">
          Mid <span className="text-foreground">{mid != null ? formatPrice(mid) : "—"}</span>
        </span>
        <span className="text-muted-foreground">
          Spread{" "}
          <span className="text-foreground">{spread != null ? formatPrice(spread) : "—"}</span>
        </span>
      </div>

      {/* Bids: best bid just below the spread row. */}
      <div className="flex flex-col">
        {bids.map((row) => (
          <LadderRow key={`bid-${row.price}`} row={row} side="bid" maxCumulative={maxCumulative} />
        ))}
      </div>
    </div>
  );
}

function LadderRow({
  row,
  side,
  maxCumulative,
}: {
  row: Row;
  side: "bid" | "ask";
  maxCumulative: number;
}) {
  const width = `${Math.min(100, (row.cumulative / maxCumulative) * 100)}%`;

  return (
    <div className="relative grid grid-cols-[1fr_1fr_1fr] gap-2 px-3 py-1 tabular-nums">
      <div
        aria-hidden
        className={cn(
          "absolute inset-y-0 right-0",
          side === "bid" ? "bg-emerald-500/15" : "bg-red-500/15",
        )}
        style={{ width }}
      />
      <span
        className={cn(
          "relative z-10",
          side === "bid"
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-red-600 dark:text-red-400",
        )}
      >
        {formatPrice(row.price)}
      </span>
      <span className="relative z-10 text-right text-foreground">{formatSize(row.size)}</span>
      <span className="relative z-10 text-right text-muted-foreground">
        {formatSize(row.cumulative)}
      </span>
    </div>
  );
}
