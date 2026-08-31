"use client";

import { ArrowDown, ArrowUp, ArrowUpDown, Check, Loader2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MAX_SYMBOLS } from "@/config/constants";
import type { OptionGreeks, OptionQuoteRow } from "@/domain/types";
import { postSubscription } from "@/lib/api/subscriptions";
import { useConfigStore } from "@/lib/stores/config-store";
import { useUiStore } from "@/lib/stores/ui-store";

type SortCol =
  | "strike"
  | "type"
  | "bid"
  | "ask"
  | "last"
  | "mark"
  | "volume"
  | "openInterest"
  | "impliedVolatility"
  | "delta"
  | "gamma"
  | "theta"
  | "vega";

interface SortState {
  col: SortCol;
  dir: "asc" | "desc";
}

const GREEK_COLS: ReadonlySet<SortCol> = new Set(["delta", "gamma", "theta", "vega"]);

function sortValue(row: OptionQuoteRow, col: SortCol): number | string | undefined {
  if (col === "type") {
    return row.type;
  }
  if (GREEK_COLS.has(col)) {
    return row.greeks?.[col as keyof OptionGreeks];
  }
  return row[col as keyof OptionQuoteRow] as number | undefined;
}

function compare(a: OptionQuoteRow, b: OptionQuoteRow, sort: SortState): number {
  const av = sortValue(a, sort.col);
  const bv = sortValue(b, sort.col);

  // Missing values always sort last, regardless of direction.
  if (av == null && bv == null) {
    return 0;
  }
  if (av == null) {
    return 1;
  }
  if (bv == null) {
    return -1;
  }

  let result: number;
  if (typeof av === "string" || typeof bv === "string") {
    result = String(av).localeCompare(String(bv));
  } else {
    result = av - bv;
  }
  return sort.dir === "asc" ? result : -result;
}

function num(value: number | undefined, digits = 2): string {
  return value == null ? "—" : value.toFixed(digits);
}

function pct(value: number | undefined): string {
  return value == null ? "—" : `${(value * 100).toFixed(1)} %`;
}

function int(value: number | undefined): string {
  return value == null ? "—" : value.toLocaleString("fr-FR");
}

const COLUMNS: ReadonlyArray<{ col: SortCol; label: string; title?: string }> = [
  { col: "strike", label: "Strike" },
  { col: "type", label: "Type" },
  { col: "bid", label: "Bid" },
  { col: "ask", label: "Ask" },
  { col: "last", label: "Dern." },
  { col: "mark", label: "Mark" },
  { col: "volume", label: "Vol" },
  { col: "openInterest", label: "OI" },
  { col: "impliedVolatility", label: "VI" },
  { col: "delta", label: "Δ", title: "Delta" },
  { col: "gamma", label: "Γ", title: "Gamma" },
  { col: "theta", label: "Θ", title: "Theta" },
  { col: "vega", label: "V", title: "Vega" },
];

export interface OptionChainTableProps {
  rows: OptionQuoteRow[];
  spot?: number;
  loading: boolean;
  error: string | null;
}

export function OptionChainTable({ rows, spot, loading, error }: OptionChainTableProps) {
  const [sort, setSort] = useState<SortState>({ col: "strike", dir: "asc" });
  const [pendingSymbol, setPendingSymbol] = useState<string | null>(null);
  const [trackError, setTrackError] = useState<string | null>(null);

  const symbols = useConfigStore((state) => state.symbols);
  const addSymbol = useConfigStore((state) => state.addSymbol);
  const sendToTicket = useUiStore((state) => state.sendToTicket);
  const tracked = useMemo(() => new Set(symbols), [symbols]);
  const atLimit = symbols.length >= MAX_SYMBOLS;

  const sorted = useMemo(() => [...rows].sort((a, b) => compare(a, b, sort)), [rows, sort]);

  const atmSymbol = useMemo(() => {
    if (spot == null || rows.length === 0) {
      return null;
    }
    let best = rows[0];
    for (const row of rows) {
      if (Math.abs(row.strike - spot) < Math.abs(best.strike - spot)) {
        best = row;
      }
    }
    return best.symbol;
  }, [rows, spot]);

  const toggleSort = (col: SortCol) => {
    setSort((current) =>
      current.col === col
        ? { col, dir: current.dir === "asc" ? "desc" : "asc" }
        : { col, dir: "asc" },
    );
  };

  const track = async (row: OptionQuoteRow) => {
    setPendingSymbol(row.symbol);
    setTrackError(null);
    try {
      await postSubscription("add", [row.symbol]);
      addSymbol(row.symbol);
    } catch (err) {
      setTrackError(err instanceof Error ? err.message : "Échec de la souscription");
    } finally {
      setPendingSymbol(null);
    }
  };

  const trade = (row: OptionQuoteRow, side: "buy" | "sell") => {
    const quote = side === "buy" ? row.ask : row.bid;
    sendToTicket({
      symbol: row.symbol,
      side,
      limitPrice: quote != null && quote > 0 ? quote : undefined,
    });
  };

  if (loading && rows.length === 0) {
    return (
      <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Chargement de la chaîne…
      </div>
    );
  }

  if (error) {
    return <p className="p-4 text-xs text-red-500">{error}</p>;
  }

  if (rows.length === 0) {
    return (
      <p className="p-8 text-center text-sm text-muted-foreground">
        Aucun contrat ne correspond à ces filtres.
      </p>
    );
  }

  return (
    <div>
      <Table>
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            {COLUMNS.map(({ col, label, title }) => {
              const active = sort.col === col;
              return (
                <TableHead
                  key={col}
                  className="text-right first:text-left [&:nth-child(2)]:text-left"
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(col)}
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    title={title}
                  >
                    {label}
                    {active ? (
                      sort.dir === "asc" ? (
                        <ArrowUp className="h-3 w-3" />
                      ) : (
                        <ArrowDown className="h-3 w-3" />
                      )
                    ) : (
                      <ArrowUpDown className="h-3 w-3 opacity-30" />
                    )}
                  </button>
                </TableHead>
              );
            })}
            <TableHead className="text-right">Ordre</TableHead>
            <TableHead className="text-right">Suivre</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((row) => {
            const isTracked = tracked.has(row.symbol);
            return (
              <TableRow
                key={row.symbol}
                className={row.symbol === atmSymbol ? "bg-muted/40" : undefined}
              >
                <TableCell className="tabular-nums">{num(row.strike, 2)}</TableCell>
                <TableCell className="capitalize">{row.type === "call" ? "Call" : "Put"}</TableCell>
                <TableCell className="text-right tabular-nums">{num(row.bid)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(row.ask)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(row.last)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(row.mark)}</TableCell>
                <TableCell className="text-right tabular-nums">{int(row.volume)}</TableCell>
                <TableCell className="text-right tabular-nums">{int(row.openInterest)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {pct(row.impliedVolatility)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {num(row.greeks?.delta, 3)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {num(row.greeks?.gamma, 4)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {num(row.greeks?.theta, 2)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {num(row.greeks?.vega, 3)}
                </TableCell>
                <TableCell className="text-right">
                  <span className="inline-flex gap-1">
                    <Button type="button" size="sm" onClick={() => trade(row, "buy")}>
                      Acheter
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => trade(row, "sell")}
                    >
                      Vendre
                    </Button>
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  {isTracked ? (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Check className="h-4 w-4" />
                      Suivi
                    </span>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={atLimit || pendingSymbol === row.symbol}
                      onClick={() => track(row)}
                    >
                      Suivre
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {trackError && <p className="p-3 text-xs text-red-500">{trackError}</p>}
      {atLimit && (
        <p className="p-3 text-xs text-muted-foreground">
          Limite de {MAX_SYMBOLS} symboles atteinte.
        </p>
      )}
    </div>
  );
}
