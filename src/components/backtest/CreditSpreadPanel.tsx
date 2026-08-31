"use client";

import { useId, useState } from "react";
import { EquityCurve } from "@/components/backtest/EquityCurve";
import { groupWarnings } from "@/components/backtest/warnings";
import { fmtNum, fmtPct, fmtUsd } from "@/components/trading/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CreditBacktestParamsInput, CreditBacktestResult } from "@/domain/backtest-credit";
import { useCreditBacktest } from "@/lib/hooks/use-credit-backtest";
import { cn } from "@/lib/utils";

/** Defaults mirror `docs/strategie-credit-spreads-spy.md`, not the schema's floors. */
const INITIAL_FORM = {
  underlyings: "SPY",
  feed: "sip" as "iex" | "sip",
  start: "2026-06-01",
  end: "2026-08-28",
  sides: "both" as "both" | "put" | "call",
  entryTimeEt: "10:00",
  minDte: "1",
  maxDte: "3",
  targetDelta: "0.175",
  spreadWidth: "5",
  strikeStep: "1",
  minCredit: "0.25",
  riskPerSidePct: "1",
  maxConcurrentSpreads: "4",
  buyingPowerCap: "12000",
  targetProfitPct: "50",
  stopMultiple: "3",
  closeAtEt: "15:30",
  ivMultiplier: "1.00",
  ivShockPerDownPct: "0.15",
  putIvPremium: "10",
  frictionPerLeg: "0.015",
  stopSlippagePct: "25",
};

type FormState = typeof INITIAL_FORM;

function Field({
  label,
  hint,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium" htmlFor={id}>
        {label}
      </label>
      <Input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
      {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function Toggle<T extends string>({
  label,
  options,
  value,
  onChange,
  hint,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium">{label}</span>
      <div className="flex gap-1 rounded-md border border-input p-1">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className={cn(
              "flex-1 rounded px-2 py-1 text-xs font-medium capitalize transition-colors",
              value === option ? "bg-primary text-primary-foreground" : "hover:bg-accent",
            )}
          >
            {option}
          </button>
        ))}
      </div>
      {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad";
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "font-mono text-sm font-medium tabular-nums",
          tone === "good" && "text-emerald-500",
          tone === "bad" && "text-red-500",
        )}
      >
        {value}
      </span>
      {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function toParams(form: FormState): CreditBacktestParamsInput {
  return {
    underlyings: form.underlyings
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    feed: form.feed,
    start: form.start,
    end: form.end,
    sides: form.sides,
    entryTimeEt: form.entryTimeEt,
    minDte: Number(form.minDte),
    maxDte: Number(form.maxDte),
    targetDelta: Number(form.targetDelta),
    spreadWidth: Number(form.spreadWidth),
    strikeStep: Number(form.strikeStep),
    minCredit: Number(form.minCredit),
    riskPerSidePct: Number(form.riskPerSidePct) / 100,
    maxConcurrentSpreads: Number(form.maxConcurrentSpreads),
    buyingPowerCap: Number(form.buyingPowerCap),
    targetProfitPct: Number(form.targetProfitPct) / 100,
    stopMultiple: Number(form.stopMultiple),
    closeAtEt: form.closeAtEt,
    ivMultiplier: Number(form.ivMultiplier),
    ivShockPerDownPct: Number(form.ivShockPerDownPct),
    putIvPremium: Number(form.putIvPremium) / 100,
    frictionPerLeg: Number(form.frictionPerLeg),
    stopSlippagePct: Number(form.stopSlippagePct) / 100,
  };
}

/**
 * The verdict. A credit spread wins most of the time by construction — a 0.175
 * delta short leg is out of the money ~82% of the time — so a high hit rate is
 * not evidence of anything. The only number that means something is whether it
 * clears the rate this payoff ratio needs.
 */
function Verdict({ result }: { result: CreditBacktestResult }) {
  const { hitRate, breakEvenHitRate, trades } = result.stats;
  if (trades === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No spread was posted over this window. The rejection counts below say why — an unmet credit
        floor is the strategy declining to trade, not a broken run.
      </p>
    );
  }
  const margin = hitRate - breakEvenHitRate;
  const clears = margin > 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "font-mono text-2xl font-semibold tabular-nums",
            clears ? "text-emerald-500" : "text-red-500",
          )}
        >
          {fmtPct(hitRate)}
        </span>
        <span className="text-sm text-muted-foreground">
          hit rate vs {fmtPct(breakEvenHitRate)} needed to break even
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {clears
          ? `Clears the bar by ${fmtPct(margin)} on ${trades} spreads. Premium selling wins often and loses big, so the bar is high by construction — a sample without a real drawdown in it has not tested the losing side at all.`
          : `Short of the bar by ${fmtPct(Math.abs(margin))} on ${trades} spreads. Winning most days is what this structure does; it still loses money at this hit rate.`}
      </p>
    </div>
  );
}

export function CreditSpreadPanel() {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const { mutate, data: result, error, isPending } = useCreditBacktest();
  const set = (key: keyof FormState) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const rejections = Object.entries(result?.rejections ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>Credit spreads 1-2 DTE</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Field label="Underlyings" value={form.underlyings} onChange={set("underlyings")} />
          <Toggle
            label="Data feed"
            options={["sip", "iex"] as const}
            value={form.feed}
            onChange={(feed) => setForm((prev) => ({ ...prev, feed }))}
          />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start" type="date" value={form.start} onChange={set("start")} />
            <Field label="End" type="date" value={form.end} onChange={set("end")} />
          </div>

          <Separator />
          <Toggle
            label="Structure"
            options={["both", "put", "call"] as const}
            value={form.sides}
            onChange={(sides) => setForm((prev) => ({ ...prev, sides }))}
            hint={
              form.sides === "both"
                ? "Iron condor — two verticals, sized and closed independently."
                : "Reduced variant: no directional neutrality, theta only."
            }
          />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Entry (ET)" value={form.entryTimeEt} onChange={set("entryTimeEt")} />
            <Field
              label="Close (ET)"
              hint="On expiry day"
              value={form.closeAtEt}
              onChange={set("closeAtEt")}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Min DTE" value={form.minDte} onChange={set("minDte")} />
            <Field label="Max DTE" value={form.maxDte} onChange={set("maxDte")} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Short delta" value={form.targetDelta} onChange={set("targetDelta")} />
            <Field label="Width ($)" value={form.spreadWidth} onChange={set("spreadWidth")} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Strike step ($)" value={form.strikeStep} onChange={set("strikeStep")} />
            <Field
              label="Min credit ($)"
              hint="An implicit IV floor"
              value={form.minCredit}
              onChange={set("minCredit")}
            />
          </div>

          <Separator />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Target (% credit)"
              value={form.targetProfitPct}
              onChange={set("targetProfitPct")}
            />
            <Field
              label="Stop (× credit)"
              value={form.stopMultiple}
              onChange={set("stopMultiple")}
            />
          </div>

          <Separator />
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-600 dark:text-amber-400">
            The IV multiplier <strong>is</strong> the edge. At 1.00 the model grants no variance
            risk premium at all — every dollar of P&amp;L then comes from the path, not from being
            paid to carry risk. Raising it manufactures the result you are testing for.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="IV multiplier" value={form.ivMultiplier} onChange={set("ivMultiplier")} />
            <Field
              label="Put IV premium (%)"
              hint="Index skew"
              value={form.putIvPremium}
              onChange={set("putIvPremium")}
            />
          </div>
          <Field
            label="IV shock per 1% down"
            hint="Relative IV rise as spot falls — trips the stop earlier"
            value={form.ivShockPerDownPct}
            onChange={set("ivShockPerDownPct")}
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Friction / leg ($)"
              value={form.frictionPerLeg}
              onChange={set("frictionPerLeg")}
            />
            <Field
              label="Stop slippage (%)"
              hint="Of the credit, above the trigger"
              value={form.stopSlippagePct}
              onChange={set("stopSlippagePct")}
            />
          </div>

          <Separator />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Risk / side (%)"
              value={form.riskPerSidePct}
              onChange={set("riskPerSidePct")}
            />
            <Field
              label="Max spreads"
              value={form.maxConcurrentSpreads}
              onChange={set("maxConcurrentSpreads")}
            />
          </div>
          <Field
            label="Buying power cap ($)"
            value={form.buyingPowerCap}
            onChange={set("buyingPowerCap")}
          />

          <Button onClick={() => mutate(toParams(form))} disabled={isPending}>
            {isPending ? "Running…" : "Run backtest"}
          </Button>
          {error ? <p className="text-sm text-red-500">{(error as Error).message}</p> : null}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-6">
        {!result ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              Run a backtest to see the equity curve.
              <br />
              <span className="text-xs">
                Evidence of guardrails under [R15] — never the official P&amp;L.
              </span>
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Verdict</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {result.params.ivMultiplier > 1 ? (
                  <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
                    Priced at {fmtNum(result.params.ivMultiplier)}× realised vol — the result below
                    is conditional on that premium actually being on offer.
                  </p>
                ) : null}
                {result.params.feed === "iex" ? (
                  <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
                    Run on the IEX feed. Its thinner tape compresses highs and lows, which here
                    understates how often a stop would have been touched.
                  </p>
                ) : null}
                <Verdict result={result} />
                <Separator />
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Stat
                    label="Final equity"
                    value={fmtUsd(result.stats.finalEquity)}
                    tone={
                      result.stats.totalPnl > 0
                        ? "good"
                        : result.stats.totalPnl < 0
                          ? "bad"
                          : undefined
                    }
                    hint={fmtPct(result.stats.returnPct)}
                  />
                  <Stat
                    label="Spreads"
                    value={String(result.stats.trades)}
                    hint={`${result.sessionsWithEntry}/${result.sessionsScanned} sessions · ${result.params.feed.toUpperCase()}`}
                  />
                  <Stat
                    label="Payoff ratio"
                    value={fmtNum(result.stats.payoffRatio)}
                    hint={`avg win ${fmtUsd(result.stats.avgWin)} / loss ${fmtUsd(result.stats.avgLoss)}`}
                  />
                  <Stat
                    label="Expectancy"
                    value={fmtUsd(result.stats.expectancy)}
                    hint="per spread"
                  />
                  <Stat
                    label="Max drawdown"
                    value={fmtUsd(result.stats.maxDrawdown)}
                    hint={fmtPct(result.stats.maxDrawdownPct)}
                  />
                  <Stat
                    label="Avg credit"
                    value={fmtNum(result.stats.avgCredit)}
                    hint={`risking ${fmtNum(result.stats.avgMaxLoss)} per share`}
                  />
                  <Stat
                    label="Avg hold"
                    value={`${Math.round(result.stats.avgMinutesHeld)}m`}
                    hint="trading minutes"
                  />
                  <Stat
                    label="Exits"
                    value={
                      Object.entries(result.stats.byExitReason)
                        .map(([k, v]) => `${k}:${v}`)
                        .join(" ") || "—"
                    }
                  />
                </div>
                {Object.keys(result.stats.bySide).length > 1 ? (
                  <>
                    <Separator />
                    <div className="grid grid-cols-2 gap-4">
                      {Object.entries(result.stats.bySide).map(([side, entry]) => (
                        <Stat
                          key={side}
                          label={`${side} side`}
                          value={fmtUsd(entry.pnl)}
                          tone={entry.pnl > 0 ? "good" : entry.pnl < 0 ? "bad" : undefined}
                          hint={`${entry.trades} spreads · ${fmtPct(entry.hitRate)} hit`}
                        />
                      ))}
                    </div>
                  </>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Equity curve</CardTitle>
              </CardHeader>
              <CardContent>
                <EquityCurve points={result.equityCurve} baseline={result.params.initialEquity} />
              </CardContent>
            </Card>

            {rejections.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>Why a side was not posted</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                  {rejections.map(([reason, count]) => (
                    <span key={reason} className="font-mono tabular-nums">
                      {reason} <span className="text-foreground">{count}</span>
                    </span>
                  ))}
                </CardContent>
              </Card>
            ) : null}

            {result.warnings.length > 0 ? (
              <Card>
                <CardHeader>
                  <CardTitle>Warnings ({groupWarnings(result.warnings).length})</CardTitle>
                </CardHeader>
                <CardContent>
                  <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto text-xs text-muted-foreground">
                    {groupWarnings(result.warnings)
                      .slice(0, 50)
                      .map(({ text, count }) => (
                        <li key={text}>
                          {text}
                          {count > 1 ? ` (×${count})` : ""}
                        </li>
                      ))}
                  </ul>
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>Spreads</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Sym</TableHead>
                      <TableHead>Side</TableHead>
                      <TableHead>Exp</TableHead>
                      <TableHead className="text-right">Strikes</TableHead>
                      <TableHead className="text-right">Δ</TableHead>
                      <TableHead className="text-right">Credit</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead>Exit</TableHead>
                      <TableHead className="text-right">Cost</TableHead>
                      <TableHead className="text-right">P&amp;L</TableHead>
                      <TableHead className="text-right">R</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.trades.map((trade) => (
                      <TableRow key={`${trade.id}-${trade.exit.timestamp}`}>
                        <TableCell className="font-mono text-xs">{trade.date}</TableCell>
                        <TableCell className="font-mono text-xs">{trade.underlying}</TableCell>
                        <TableCell className="text-xs">{trade.side}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {trade.expiration.slice(5)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {fmtNum(trade.shortStrike)}/{fmtNum(trade.longStrike)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {trade.shortDelta.toFixed(2)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {trade.credit.toFixed(2)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {trade.contracts}
                        </TableCell>
                        <TableCell className="text-xs">{trade.exit.reason}</TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {trade.exit.cost.toFixed(2)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right font-mono text-xs tabular-nums",
                            trade.pnl > 0
                              ? "text-emerald-500"
                              : trade.pnl < 0
                                ? "text-red-500"
                                : "",
                          )}
                        >
                          {fmtUsd(trade.pnl)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {fmtNum(trade.rMultiple)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
