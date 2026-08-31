"use client";

import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MAX_SYMBOLS } from "@/config/constants";
import { useConfigStore } from "@/lib/stores/config-store";
import { useUiStore } from "@/lib/stores/ui-store";

export function OptionSearchButton() {
  const dataFeed = useConfigStore((state) => state.dataFeed);
  const symbolCount = useConfigStore((state) => state.symbols.length);
  const setOpen = useUiStore((state) => state.setOptionsSearchOpen);

  const testFeed = dataFeed === "test";
  const atLimit = symbolCount >= MAX_SYMBOLS;

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Options</p>

      <Button
        type="button"
        variant="outline"
        className="w-full justify-start gap-2"
        disabled={testFeed}
        onClick={() => setOpen(true)}
      >
        <Search className="h-4 w-4" />
        Rechercher des options
      </Button>

      {testFeed && (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          Les données d'options nécessitent un flux live. Définissez{" "}
          <code>ALPACA_DATA_FEED=iex</code> (ou <code>sip</code>).
        </p>
      )}

      {!testFeed && atLimit && (
        <p className="text-xs text-muted-foreground">
          Limite de {MAX_SYMBOLS} symboles atteinte. Retirez-en un pour suivre une option.
        </p>
      )}
    </div>
  );
}
