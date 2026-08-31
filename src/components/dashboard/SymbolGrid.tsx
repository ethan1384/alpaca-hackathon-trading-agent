"use client";

import { useConfigStore } from "@/lib/stores/config-store";
import { SymbolCard } from "./SymbolCard";

export function SymbolGrid() {
  const symbols = useConfigStore((state) => state.symbols);

  if (symbols.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">
        Add a symbol to start streaming market data.
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {symbols.map((symbol) => (
        <SymbolCard key={symbol} symbol={symbol} />
      ))}
    </div>
  );
}
