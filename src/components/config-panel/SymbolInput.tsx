"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MAX_SYMBOLS } from "@/config/constants";
import { displayInstrumentLabel } from "@/domain/types";
import { postSubscription } from "@/lib/api/subscriptions";
import { useConfigStore } from "@/lib/stores/config-store";

export function SymbolInput() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { symbols, addSymbol, removeSymbol } = useConfigStore();

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const symbol = value.trim().toUpperCase();
    if (!symbol) {
      return;
    }

    setPending(true);
    setError(null);

    try {
      await postSubscription("add", [symbol]);
      addSymbol(symbol);
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add symbol");
    } finally {
      setPending(false);
    }
  };

  const onRemove = async (symbol: string) => {
    setPending(true);
    setError(null);

    try {
      await postSubscription("remove", [symbol]);
      removeSymbol(symbol);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove symbol");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-3">
      <form onSubmit={onSubmit} className="flex gap-2">
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value.toUpperCase())}
          placeholder="AAPL or BTC/USD"
          disabled={pending || symbols.length >= MAX_SYMBOLS}
        />
        <Button type="submit" disabled={pending || symbols.length >= MAX_SYMBOLS}>
          Add
        </Button>
      </form>

      <p className="text-xs text-muted-foreground">
        {symbols.length}/{MAX_SYMBOLS} symbols · {symbols.length * 3}/{30} WS channels
      </p>

      {error && <p className="text-xs text-red-500">{error}</p>}

      <ul className="space-y-2">
        {symbols.map((symbol) => (
          <li
            key={symbol}
            className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
          >
            <span>{displayInstrumentLabel(symbol)}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => onRemove(symbol)}
            >
              Remove
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
