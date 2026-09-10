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
import type { BacktestParamsInput, BacktestResult } from "@/domain/backtest";
import { useBacktest } from "@/lib/hooks/use-backtest";
import { cn } from "@/lib/utils";

/** Defaults mirror the calibrated strategy, not the schema's permissive floors. */
const INITIAL_FORM = {
  underlyings: "SPY,QQQ",
  feed: "sip" as "iex" | "sip",
  start: "2026-06-01",
  end: "2026-08-28",
  openingRangeMinutes: "30",
  widthMode: "fixed" as "range" | "fixed",
  fixedWidth: "3",
  strikeStep: "1",
  stopBufferPct: "50",
  riskPerTradePct: "1",
  targetDelta: "0.45",
  frictionPerLeg: "0.015",
  stopRecoveryPct: "15",
};

type FormState = typeof INITIAL_FORM;

export function Field({
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

export function Stat({
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

function toParams(form: FormState): BacktestParamsInput {
  return {
    underlyings: form.underlyings
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    feed: form.feed,
    start: form.start,
    end: form.end,
    openingRangeMinutes: Number(form.openingRangeMinutes),
    widthMode: form.widthMode,
    fixedWidth: Number(form.fixedWidth),
    strikeStep: Number(form.strikeStep),
    stopBufferPct: Number(form.stopBufferPct) / 100,
    riskPerTradePct: Number(form.riskPerTradePct) / 100,
    targetDelta: Number(form.targetDelta),
    frictionPerLeg: Number(form.frictionPerLeg),
    stopRecoveryPct: Number(form.stopRecoveryPct) / 100,
  };
}

/**
 * The verdict, stated before any P&L: a debit vertical whose average loss sits
 * near its maximum needs a hit rate above `1 / (1 + payoff)`. Terminal equity
 * over a short sample is mostly variance; this comparison is not.
 */
function Verdict({ result }: { result: BacktestResult }) {
  const { hitRate, breakEvenHitRate, trades } = result.stats;
  if (trades === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No trade was taken over this window — widen the range or relax the filters.
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
          ? `Clears the bar by ${fmtPct(margin)} on ${trades} trades. A short sample can clear it by luck — check the trade count before trusting it.`
          : `Short of the bar by ${fmtPct(Math.abs(margin))} on ${trades} trades. The structure loses money at this hit rate regardless of the equity curve's shape.`}
      </p>
    </div>
  );
}

export function BacktestPanel() {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const { mutate, data: result, error, isPending } = useBacktest();
  const set = (key: keyof FormState) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));
  const setFeed = (feed: "iex" | "sip") => setForm((prev) => ({ ...prev, feed }));
  const setWidthMode = (widthMode: "range" | "fixed") =>
    setForm((prev) => ({ ...prev, widthMode }));

  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>ORB → 0DTE vertical</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Field label="Underlyings" value={form.underlyings} onChange={set("underlyings")} />

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">Data feed</span>
            <div className="flex gap-1 rounded-md border border-input p-1">
              {(["sip", "iex"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFeed(f)}
                  className={cn(
                    "flex-1 rounded px-2 py-1 text-xs font-medium uppercase transition-colors",
                    form.feed === f ? "bg-primary text-primary-foreground" : "hover:bg-accent",
                  )}
                >
                  {f}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-muted-foreground">
              IEX prints ~4% of consolidated volume — the opening range and the volume trigger come
              out of a different tape than the one you would trade.
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start" type="date" value={form.start} onChange={set("start")} />
            <Field label="End" type="date" value={form.end} onChange={set("end")} />
          </div>

          <Separator />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Range (min)"
              value={form.openingRangeMinutes}
              onChange={set("openingRangeMinutes")}
            />
            <Field
              label="Stop buffer (%)"
              hint="Of the range, inside its edge"
              value={form.stopBufferPct}
              onChange={set("stopBufferPct")}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Entry is a close beyond the edge, so a 0% buffer puts the stop a few ticks away and it
            fires on noise around the breakout.
          </p>

          <Separator />
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">Spread width</span>
            <div className="flex gap-1 rounded-md border border-input p-1">
              {(["range", "fixed"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setWidthMode(m)}
                  className={cn(
                    "flex-1 rounded px-2 py-1 text-xs font-medium capitalize transition-colors",
                    form.widthMode === m ? "bg-primary text-primary-foreground" : "hover:bg-accent",
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
            <span className="text-[11px] text-muted-foreground">
              {form.widthMode === "range"
                ? "One opening range per trade, rounded to the strike step — so the target sits on the short strike by construction. Width varies day to day."
                : "The same width on every trade, whatever the range was."}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Fixed width ($)"
              hint={form.widthMode === "range" ? "unused in range mode" : undefined}
              value={form.fixedWidth}
              onChange={set("fixedWidth")}
            />
            <Field
              label="Strike step ($)"
              hint="Applied to every underlying"
              value={form.strikeStep}
              onChange={set("strikeStep")}
            />
          </div>

          <Separator />
          <p className="text-[11px] text-muted-foreground">
            The two knobs below decide the answer. They are pessimistic on purpose — a 0DTE stop
            rarely returns much of the debit.
          </p>
          <Field
            label="Stop recovery (%)"
            hint="Share of the debit returned when the stop fires"
            value={form.stopRecoveryPct}
            onChange={set("stopRecoveryPct")}
          />
          <Field
            label="Friction per leg ($)"
            hint="Given up per leg per crossing, paid on entry and exit"
            value={form.frictionPerLeg}
            onChange={set("frictionPerLeg")}
          />

          <Separator />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Risk / trade (%)"
              value={form.riskPerTradePct}
              onChange={set("riskPerTradePct")}
            />
            <Field label="Target delta" value={form.targetDelta} onChange={set("targetDelta")} />
          </div>

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
                {result.params.feed === "iex" ? (
                  <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-600 dark:text-amber-400">
                    Run on the IEX feed (~4% of volume). Treat the numbers below as a smoke test of
                    the pipeline, not as a verdict on the strategy.
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
                    label="Trades"
                    value={String(result.stats.trades)}
                    hint={`${result.sessionsWithTrigger}/${result.sessionsScanned} sessions · ${result.params.feed.toUpperCase()}`}
                  />
                  <Stat
                    label="Payoff ratio"
                    value={fmtNum(result.stats.payoffRatio)}
                    hint={`avg win ${fmtUsd(result.stats.avgWin)} / loss ${fmtUsd(result.stats.avgLoss)}`}
                  />
                  <Stat
                    label="Expectancy"
                    value={fmtUsd(result.stats.expectancy)}
                    hint="per trade"
                  />
                  <Stat
                    label="Max drawdown"
                    value={fmtUsd(result.stats.maxDrawdown)}
                    hint={fmtPct(result.stats.maxDrawdownPct)}
                  />
                  <Stat
                    label="Reached target"
                    value={fmtPct(result.stats.targetReachedRate)}
                    hint="of trades"
                  />
                  <Stat
                    label="Wins / losses"
                    value={`${result.stats.wins} / ${result.stats.losses}`}
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
                <CardTitle>Trades</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Sym</TableHead>
                      <TableHead>Dir</TableHead>
                      <TableHead className="text-right">Strikes</TableHead>
                      <TableHead className="text-right">W</TableHead>
                      <TableHead className="text-right">Debit</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Exit</TableHead>
                      <TableHead className="text-right">P&amp;L</TableHead>
                      <TableHead className="text-right">R</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.trades.map((trade) => (
                      <TableRow key={trade.id}>
                        <TableCell className="font-mono text-xs">{trade.date}</TableCell>
                        <TableCell className="font-mono text-xs">{trade.underlying}</TableCell>
                        <TableCell className="text-xs">{trade.direction}</TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {fmtNum(trade.longStrike)}/{fmtNum(trade.shortStrike)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {fmtNum(trade.width)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {fmtNum(trade.entryDebit)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {trade.contracts}
                        </TableCell>
                        <TableCell className="text-xs">
                          {trade.exits.at(-1)?.reason ?? "—"}
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
