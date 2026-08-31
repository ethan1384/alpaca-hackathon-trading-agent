"use client";

import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  ORDER_TYPES,
  type OrderType,
  PlaceOrderSchema,
  TIME_IN_FORCE,
  type TimeInForce,
} from "@/domain/trading";
import {
  detectAssetClass,
  displayInstrumentLabel,
  formatOptionLabel,
  isOptionSymbol,
  parseOptionSymbol,
} from "@/domain/types";
import { useClock } from "@/lib/hooks/use-clock";
import { usePlaceOrder } from "@/lib/hooks/use-trading";
import { useConfigStore } from "@/lib/stores/config-store";
import { useUiStore } from "@/lib/stores/ui-store";
import { cn } from "@/lib/utils";

const TYPE_LABELS: Record<OrderType, string> = {
  market: "Market",
  limit: "Limit",
  stop: "Stop",
  stop_limit: "Stop limit",
  trailing_stop: "Trailing stop",
};

const TIF_LABELS: Record<TimeInForce, string> = {
  day: "Journée",
  gtc: "Jusqu'à annulation",
  opg: "À l'ouverture",
  cls: "À la clôture",
  ioc: "Immédiat",
  fok: "Tout ou rien",
};

type SizeMode = "qty" | "notional";

/**
 * Alpaca refuses several order shapes on options and only says so in the 422.
 * Filter the ticket down to what the API accepts so the choice is never offered:
 * no trailing stops, no extended hours, no bracket/OCO/OTO ("complex orders not
 * supported for options trading"), and `day`/`gtc` only for time-in-force.
 */
const OPTION_ORDER_TYPES: readonly OrderType[] = ["market", "limit", "stop", "stop_limit"];
const OPTION_TIF: readonly TimeInForce[] = ["day", "gtc"];

export function OrderTicket() {
  const placeOrder = usePlaceOrder();
  const symbols = useConfigStore((state) => state.symbols);
  const dataFeed = useConfigStore((state) => state.dataFeed);
  const ticketIntent = useUiStore((state) => state.ticketIntent);
  const setTicketIntent = useUiStore((state) => state.setTicketIntent);
  const setOptionsSearchOpen = useUiStore((state) => state.setOptionsSearchOpen);
  const setOptionsSearchUnderlying = useUiStore((state) => state.setOptionsSearchUnderlying);
  const testFeed = dataFeed === "test";

  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [type, setType] = useState<OrderType>("market");
  const [tif, setTif] = useState<TimeInForce>("day");
  const [sizeMode, setSizeMode] = useState<SizeMode>("qty");
  const [size, setSize] = useState("");
  const [limitPrice, setLimitPrice] = useState("");
  const [stopPrice, setStopPrice] = useState("");
  const [trailMode, setTrailMode] = useState<"trailPrice" | "trailPercent">("trailPrice");
  const [trail, setTrail] = useState("");
  const [extendedHours, setExtendedHours] = useState(false);
  const [bracket, setBracket] = useState(false);
  const [takeProfit, setTakeProfit] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ticketIntent) {
      return;
    }
    setSymbol(ticketIntent.symbol);
    setSide(ticketIntent.side);
    if (ticketIntent.limitPrice != null && Number.isFinite(ticketIntent.limitPrice)) {
      setType("limit");
      setLimitPrice(String(ticketIntent.limitPrice));
    }
  }, [ticketIntent]);

  // Snap the ticket back to a shape Alpaca accepts when an option is loaded.
  useEffect(() => {
    if (!isOptionSymbol(symbol)) {
      return;
    }
    setType((t) => (OPTION_ORDER_TYPES.includes(t) ? t : "limit"));
    setTif((t) => (OPTION_TIF.includes(t) ? t : "day"));
    setExtendedHours(false);
    setBracket(false);
  }, [symbol]);

  const trackedOptions = useMemo(
    () =>
      symbols
        .map((s) => parseOptionSymbol(s))
        .filter((contract): contract is NonNullable<typeof contract> => contract != null),
    [symbols],
  );

  const { data: clock } = useClock();
  const contract = parseOptionSymbol(symbol);
  const option = isOptionSymbol(symbol);
  const orderTypes = option ? OPTION_ORDER_TYPES : ORDER_TYPES;
  const tifOptions = option ? OPTION_TIF : TIME_IN_FORCE;
  // Options market orders are rejected outside RTH; limit orders rest until open.
  const marketClosedWarning = option && type === "market" && clock != null && !clock.isOpen;
  const needsLimit = type === "limit" || type === "stop_limit";
  const needsStop = type === "stop" || type === "stop_limit";
  const needsTrail = type === "trailing_stop";
  const effectiveSizeMode = option ? "qty" : sizeMode;

  const payload = useMemo(() => {
    const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
    return {
      symbol,
      side,
      type,
      timeInForce: tif,
      qty: effectiveSizeMode === "qty" ? num(size) : undefined,
      notional: effectiveSizeMode === "notional" ? num(size) : undefined,
      limitPrice: needsLimit ? num(limitPrice) : undefined,
      stopPrice: needsStop ? num(stopPrice) : undefined,
      trailPrice: needsTrail && trailMode === "trailPrice" ? num(trail) : undefined,
      trailPercent: needsTrail && trailMode === "trailPercent" ? num(trail) : undefined,
      extendedHours: extendedHours || undefined,
      takeProfit: bracket && takeProfit ? { limitPrice: Number(takeProfit) } : undefined,
      stopLoss: bracket && stopLoss ? { stopPrice: Number(stopLoss) } : undefined,
    };
  }, [
    symbol,
    side,
    type,
    tif,
    effectiveSizeMode,
    size,
    needsLimit,
    limitPrice,
    needsStop,
    stopPrice,
    needsTrail,
    trailMode,
    trail,
    extendedHours,
    bracket,
    takeProfit,
    stopLoss,
  ]);

  function openContractPicker() {
    const fromContract = contract?.underlying;
    const firstEquity = symbols.find((s) => detectAssetClass(s) === "stock");
    const seed = fromContract ?? firstEquity ?? "";
    if (seed) {
      setOptionsSearchUnderlying(seed);
    }
    setOptionsSearchOpen(true);
  }

  function pickTracked(next: string) {
    setSymbol(next);
    setType("market");
    setLimitPrice("");
    setTicketIntent({ symbol: next, side });
  }

  function submit() {
    setError(null);
    const parsed = PlaceOrderSchema.safeParse(payload);
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join(" · "));
      return;
    }
    placeOrder.mutate(parsed.data, {
      onSuccess: () => {
        setSize("");
        setLimitPrice("");
        setStopPrice("");
        setTrail("");
        setTakeProfit("");
        setStopLoss("");
      },
      onError: (e) => setError((e as Error).message),
    });
  }

  const readable = symbol ? displayInstrumentLabel(symbol) : "";

  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle>Ticket d'ordre</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setSide("buy")}
            className={cn(
              "h-9 rounded-md border text-sm font-medium transition-colors",
              side === "buy"
                ? "border-emerald-500 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                : "border-input hover:bg-accent",
            )}
          >
            Acheter
          </button>
          <button
            type="button"
            onClick={() => setSide("sell")}
            className={cn(
              "h-9 rounded-md border text-sm font-medium transition-colors",
              side === "sell"
                ? "border-red-500 bg-red-500/15 text-red-600 dark:text-red-400"
                : "border-input hover:bg-accent",
            )}
          >
            Vendre
          </button>
        </div>

        <Field label="Contrat">
          {contract ? (
            <div className="rounded-md border px-3 py-2">
              <p className="text-sm font-medium">{formatOptionLabel(contract)}</p>
              <p className="font-mono text-[11px] text-muted-foreground" title={symbol}>
                {symbol}
              </p>
            </div>
          ) : symbol ? (
            <div className="rounded-md border px-3 py-2">
              <p className="text-sm font-medium">{symbol}</p>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Choisissez un call ou un put (strike et échéance) — pas besoin du symbole OCC.
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            className="w-full justify-start gap-2"
            disabled={testFeed}
            onClick={openContractPicker}
          >
            <Search className="h-4 w-4" />
            {symbol ? "Changer de contrat" : "Choisir un contrat"}
          </Button>
          {testFeed ? (
            <p className="text-xs text-muted-foreground">
              Les données d'options nécessitent un flux live. Définissez{" "}
              <code>ALPACA_DATA_FEED=iex</code> (ou <code>sip</code>).
            </p>
          ) : null}
          {trackedOptions.length > 0 ? (
            <Select
              value={trackedOptions.some((c) => c.symbol === symbol) ? symbol : undefined}
              onValueChange={pickTracked}
            >
              <SelectTrigger aria-label="Contrats suivis">
                <SelectValue placeholder="Contrats suivis" />
              </SelectTrigger>
              <SelectContent>
                {trackedOptions.map((c) => (
                  <SelectItem key={c.symbol} value={c.symbol}>
                    {formatOptionLabel(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            <Select value={type} onValueChange={(v) => setType(v as OrderType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {orderTypes.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Validité">
            <Select value={tif} onValueChange={(v) => setTif(v as TimeInForce)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {tifOptions.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TIF_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <Field
          label={
            <span className="flex items-center gap-2">
              Taille
              {option ? null : (
                <ToggleGroup
                  value={sizeMode}
                  onChange={(v) => setSizeMode(v as SizeMode)}
                  options={[
                    { value: "qty", label: "Qty" },
                    { value: "notional", label: "$" },
                  ]}
                />
              )}
            </span>
          }
        >
          <Input
            type="number"
            inputMode="decimal"
            value={size}
            onChange={(e) => setSize(e.target.value)}
            placeholder={option || effectiveSizeMode === "qty" ? "Contrats" : "Montant en $"}
          />
        </Field>

        {needsLimit ? (
          <Field label="Prix limite">
            <Input
              type="number"
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
            />
          </Field>
        ) : null}
        {needsStop ? (
          <Field label="Prix stop">
            <Input type="number" value={stopPrice} onChange={(e) => setStopPrice(e.target.value)} />
          </Field>
        ) : null}
        {needsTrail ? (
          <Field
            label={
              <span className="flex items-center gap-2">
                Trail
                <ToggleGroup
                  value={trailMode}
                  onChange={(v) => setTrailMode(v as typeof trailMode)}
                  options={[
                    { value: "trailPrice", label: "$" },
                    { value: "trailPercent", label: "%" },
                  ]}
                />
              </span>
            }
          >
            <Input type="number" value={trail} onChange={(e) => setTrail(e.target.value)} />
          </Field>
        ) : null}

        {marketClosedWarning ? (
          <p className="text-xs text-amber-600 dark:text-amber-500">
            Marché fermé : Alpaca refuse les ordres au marché sur options hors séance. Passez en
            ordre limite — il restera en attente jusqu'à l'ouverture.
          </p>
        ) : null}

        {option ? null : (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={extendedHours}
              onChange={(e) => setExtendedHours(e.target.checked)}
            />
            Horaires étendus
          </label>
        )}

        {option ? null : <Separator />}

        {option ? null : (
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={bracket}
              onChange={(e) => setBracket(e.target.checked)}
            />
            Take-profit / stop-loss (bracket)
          </label>
        )}
        {bracket && !option ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Take-profit limite">
              <Input
                type="number"
                value={takeProfit}
                onChange={(e) => setTakeProfit(e.target.value)}
              />
            </Field>
            <Field label="Stop-loss">
              <Input type="number" value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} />
            </Field>
          </div>
        ) : null}

        {error ? <p className="text-sm text-red-500">{error}</p> : null}

        <Button
          className="w-full"
          disabled={placeOrder.isPending || !symbol}
          onClick={submit}
          variant={side === "sell" ? "outline" : "default"}
        >
          {placeOrder.isPending
            ? "Envoi…"
            : `${side === "buy" ? "Acheter" : "Vendre"} ${readable}`.trim()}
        </Button>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  // Not a <label>: the control is passed as `children`, so biome can't verify the
  // association. The nested Input/Select carry their own accessible names.
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function ToggleGroup({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <span className="inline-flex overflow-hidden rounded border border-input">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "px-2 py-0.5 text-xs transition-colors",
            value === o.value ? "bg-primary text-primary-foreground" : "hover:bg-accent",
          )}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}
