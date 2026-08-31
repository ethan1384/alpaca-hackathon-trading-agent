"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { OptionChainType } from "@/domain/types";

const ATM_PRESETS = [0.05, 0.1, 0.2] as const;

export interface OptionChainFiltersProps {
  underlying: string;
  onUnderlyingChange(value: string): void;
  expiration: string;
  onExpirationChange(value: string): void;
  expirations: string[];
  loadingExpirations: boolean;
  expirationsError: boolean;
  type: OptionChainType;
  onTypeChange(value: OptionChainType): void;
  strikeMin: string;
  strikeMax: string;
  onStrikeMinChange(value: string): void;
  onStrikeMaxChange(value: string): void;
  atmPreset: number | null;
  onAtmPresetChange(value: number | null): void;
  spot?: number;
}

const TYPE_LABELS: Record<OptionChainType, string> = {
  call: "Call",
  put: "Put",
  all: "Tous",
};

export function OptionChainFilters(props: OptionChainFiltersProps) {
  const {
    underlying,
    onUnderlyingChange,
    expiration,
    onExpirationChange,
    expirations,
    loadingExpirations,
    expirationsError,
    type,
    onTypeChange,
    strikeMin,
    strikeMax,
    onStrikeMinChange,
    onStrikeMaxChange,
    atmPreset,
    onAtmPresetChange,
    spot,
  } = props;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input
          value={underlying}
          onChange={(event) =>
            onUnderlyingChange(event.target.value.toUpperCase().replace(/[^A-Z]/g, ""))
          }
          placeholder="Sous-jacent (ex. AAPL)"
          aria-label="Sous-jacent"
        />

        <Select
          value={expiration}
          onValueChange={onExpirationChange}
          disabled={loadingExpirations || expirations.length === 0}
        >
          <SelectTrigger aria-label="Échéance">
            <SelectValue
              placeholder={loadingExpirations ? "Chargement des échéances…" : "Échéance"}
            />
          </SelectTrigger>
          <SelectContent className="z-[60]">
            {expirations.map((date) => (
              <SelectItem key={date} value={date}>
                {date}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex gap-2">
          {(["call", "put", "all"] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={type === value ? "default" : "outline"}
              className="flex-1"
              onClick={() => onTypeChange(value)}
            >
              {TYPE_LABELS[value]}
            </Button>
          ))}
        </div>

        <div className="flex gap-2">
          <Input
            value={strikeMin}
            inputMode="decimal"
            onChange={(event) => {
              onStrikeMinChange(event.target.value);
              onAtmPresetChange(null);
            }}
            placeholder="Strike min"
            aria-label="Strike minimum"
          />
          <Input
            value={strikeMax}
            inputMode="decimal"
            onChange={(event) => {
              onStrikeMaxChange(event.target.value);
              onAtmPresetChange(null);
            }}
            placeholder="Strike max"
            aria-label="Strike maximum"
          />
        </div>
      </div>

      {spot != null && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">ATM ±</span>
          {ATM_PRESETS.map((preset) => (
            <Button
              key={preset}
              type="button"
              size="sm"
              variant={atmPreset === preset ? "default" : "outline"}
              onClick={() => {
                onAtmPresetChange(preset);
                onStrikeMinChange("");
                onStrikeMaxChange("");
              }}
            >
              {Math.round(preset * 100)}%
            </Button>
          ))}
          {atmPreset != null && (
            <Button type="button" size="sm" variant="ghost" onClick={() => onAtmPresetChange(null)}>
              Effacer
            </Button>
          )}
        </div>
      )}

      {expirationsError && (
        <p className="text-xs text-red-500">
          Impossible de charger les échéances pour {underlying || "ce sous-jacent"}.
        </p>
      )}
    </div>
  );
}
