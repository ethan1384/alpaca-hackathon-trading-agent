"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { OptionChainType } from "@/domain/types";
import { useOptionChain } from "@/lib/hooks/use-option-chain";
import { useOptionExpirations } from "@/lib/hooks/use-option-expirations";
import { useConfigStore } from "@/lib/stores/config-store";
import { useUiStore } from "@/lib/stores/ui-store";
import { OptionChainFilters } from "./OptionChainFilters";
import { OptionChainTable } from "./OptionChainTable";

const VALID_UNDERLYING = /^[A-Za-z]{1,6}$/;

export function OptionChainDialog() {
  const open = useUiStore((state) => state.optionsSearchOpen);
  const setOpen = useUiStore((state) => state.setOptionsSearchOpen);
  const seedUnderlying = useUiStore((state) => state.optionsSearchUnderlying);
  const setSeedUnderlying = useUiStore((state) => state.setOptionsSearchUnderlying);
  const dataFeed = useConfigStore((state) => state.dataFeed);
  const liveFeed = dataFeed !== "test";

  const [underlying, setUnderlying] = useState("");
  const [expiration, setExpiration] = useState("");
  const [type, setType] = useState<OptionChainType>("all");
  const [strikeMin, setStrikeMin] = useState("");
  const [strikeMax, setStrikeMax] = useState("");
  const [atmPreset, setAtmPreset] = useState<number | null>(0.1);

  useEffect(() => {
    if (!open || !seedUnderlying) {
      return;
    }
    setUnderlying(seedUnderlying);
    setSeedUnderlying(null);
  }, [open, seedUnderlying, setSeedUnderlying]);

  const validUnderlying = VALID_UNDERLYING.test(underlying);

  const expirationsQuery = useOptionExpirations(underlying, open && liveFeed);
  const expirations = useMemo(
    () => expirationsQuery.data?.expirations ?? [],
    [expirationsQuery.data],
  );

  // Auto-select the nearest expiration once the list arrives.
  useEffect(() => {
    if (expirations.length === 0) {
      return;
    }
    if (!expiration || !expirations.includes(expiration)) {
      setExpiration(expirations[0]);
    }
  }, [expirations, expiration]);

  // Reset the expiration when the underlying changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only on underlying change
  useEffect(() => {
    setExpiration("");
  }, [underlying]);

  const strikeGte = atmPreset == null ? Number(strikeMin) || undefined : undefined;
  const strikeLte = atmPreset == null ? Number(strikeMax) || undefined : undefined;
  const moneyness = atmPreset ?? undefined;

  const chainQuery = useOptionChain(
    { underlying, expiration, type, strikeGte, strikeLte, moneyness },
    open && liveFeed && validUnderlying && expiration.length === 10,
  );

  const spot = chainQuery.data?.spot;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[85vh] w-[95vw] max-w-5xl flex-col gap-4 overflow-hidden">
        <DialogHeader>
          <DialogTitle>Recherche d'options</DialogTitle>
          <DialogDescription>
            {spot != null
              ? `${underlying} ~ ${spot.toFixed(2)} · flux indicatif (différé 15 min)`
              : "Choisissez un contrat (Call/Put, strike, échéance), puis Acheter ou Vendre."}
          </DialogDescription>
        </DialogHeader>

        <OptionChainFilters
          underlying={underlying}
          onUnderlyingChange={setUnderlying}
          expiration={expiration}
          onExpirationChange={setExpiration}
          expirations={expirations}
          loadingExpirations={expirationsQuery.isLoading && validUnderlying}
          expirationsError={expirationsQuery.isError}
          type={type}
          onTypeChange={setType}
          strikeMin={strikeMin}
          strikeMax={strikeMax}
          onStrikeMinChange={setStrikeMin}
          onStrikeMaxChange={setStrikeMax}
          atmPreset={atmPreset}
          onAtmPresetChange={setAtmPreset}
          spot={spot}
        />

        <div className="min-h-0 flex-1 overflow-auto rounded-md border">
          <OptionChainTable
            rows={chainQuery.data?.rows ?? []}
            spot={spot}
            loading={chainQuery.isLoading || chainQuery.isFetching}
            error={chainQuery.isError ? (chainQuery.error as Error).message : null}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
