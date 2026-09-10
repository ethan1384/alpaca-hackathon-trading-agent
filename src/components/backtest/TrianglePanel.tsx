"use client";

import { useState } from "react";
import { Field, Stat } from "@/components/backtest/BacktestPanel";
import { DrawdownChart } from "@/components/backtest/DrawdownChart";
import { EquityCurve } from "@/components/backtest/EquityCurve";
import { EXIT_COLORS, TriangleTradeChart } from "@/components/backtest/TriangleTradeChart";
import { groupWarnings } from "@/components/backtest/warnings";
import { fmtNum, fmtPct, fmtUsd } from "@/components/trading/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  TRIANGLE_DEFAULT_UNIVERSE,
  type TriangleBacktestParamsInput,
  type TriangleBacktestResult,
  type TriangleTrade,
} from "@/domain/backtest-triangle";
import { useTriangleBacktest } from "@/lib/hooks/use-triangle-backtest";
import { cn } from "@/lib/utils";

/** Defaults mirror `TriangleBacktestParamsSchema`; percentages are entered as percent. */
const INITIAL_FORM = {
  underlyings: TRIANGLE_DEFAULT_UNIVERSE.join(","),
  feed: "sip" as "iex" | "sip",
  start: "2023-09-01",
  end: "2026-09-04",
  structure: "bull_call_spread" as "bull_call_spread" | "long_call",
  stopMode: "resistance" as "resistance" | "support",
  minTouches: "3",
  touchTolerancePct: "1",
  volumeMultiple: "1.2",
  minHeightPct: "3",
  stopBufferPct: "2",
  targetDelta: "0.45",
  dteDays: "35",
  maxHoldDays: "15",
  riskPerTradePct: "1",
  maxOpenPositions: "5",
  frictionPct: "3",
  ivMultiplier: "1.1",
};

type FormState = typeof INITIAL_FORM;

function toParams(form: FormState): TriangleBacktestParamsInput {
  return {
    underlyings: form.underlyings
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    feed: form.feed,
    start: form.start,
    end: form.end,
    structure: form.structure,
    stopMode: form.stopMode,
    minTouches: Number(form.minTouches),
    touchTolerancePct: Number(form.touchTolerancePct) / 100,
    volumeMultiple: Number(form.volumeMultiple),
    minHeightPct: Number(form.minHeightPct) / 100,
    stopBufferPct: Number(form.stopBufferPct) / 100,
    targetDelta: Number(form.targetDelta),
    dteDays: Number(form.dteDays),
    maxHoldDays: Number(form.maxHoldDays),
    riskPerTradePct: Number(form.riskPerTradePct) / 100,
    maxOpenPositions: Number(form.maxOpenPositions),
    frictionPct: Number(form.frictionPct) / 100,
    ivMultiplier: Number(form.ivMultiplier),
  };
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  hint,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
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
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={cn(
              "flex-1 rounded px-2 py-1 text-xs font-medium transition-colors",
              value === option.value ? "bg-primary text-primary-foreground" : "hover:bg-accent",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      {hint ? <span className="text-[11px] text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/** Same framing as the ORB verdict: the hit rate against what the payoff needs. */
function Verdict({ result }: { result: TriangleBacktestResult }) {
  const { hitRate, breakEvenHitRate, trades } = result.stats;
  if (trades === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No trade was taken over this window — widen the universe or relax the pattern filters.
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
          ? `Clears the bar by ${fmtPct(margin)} on ${trades} trades. A sample this size can clear it by luck — read the funnel and the trade count before trusting it.`
          : `Short of the bar by ${fmtPct(Math.abs(margin))} on ${trades} trades. The structure loses money at this hit rate whatever the equity curve looks like.`}
      </p>
    </div>
  );
}

function Funnel({ result }: { result: TriangleBacktestResult }) {
  const f = result.funnel;
  const rows: { label: string; value: number; tone?: "good" | "muted" }[] = [
    { label: "Breakouts on volume", value: f.breakouts },
    { label: "→ taken", value: f.taken, tone: "good" },
    { label: "→ book full / underlying held", value: f.skippedCapacity, tone: "muted" },
    { label: "→ gapped past target / bad debit", value: f.skippedStructure, tone: "muted" },
    { label: "→ too big to size", value: f.skippedSizing, tone: "muted" },
    { label: "→ no entry bar / no vol history", value: f.skippedData, tone: "muted" },
    { label: "Breakouts on thin volume (filtered out)", value: f.rejectedVolume, tone: "muted" },
  ];
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-[220px_1fr_40px] items-center gap-2 text-xs">
          <span className={cn(row.tone === "muted" && "text-muted-foreground")}>{row.label}</span>
          <div className="h-2 rounded bg-muted">
            <div
              className={cn(
                "h-2 rounded",
                row.tone === "good"
                  ? "bg-emerald-500"
                  : row.tone === "muted"
                    ? "bg-slate-400/60"
                    : "bg-amber-500",
              )}
              style={{ width: `${(row.value / max) * 100}%` }}
            />
          </div>
          <span className="text-right font-mono tabular-nums">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

const R_EDGES = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.5, 2];

/** Histogram of trade outcomes in R. A debit structure cannot lose more than -1R. */
function RDistribution({ trades }: { trades: TriangleTrade[] }) {
  const buckets = R_EDGES.map((edge, i) => ({
    label: i === R_EDGES.length - 1 ? `≥${edge}` : `${edge}`,
    negative: edge < 0,
    count: trades.filter((t) => {
      const upper = R_EDGES[i + 1];
      return i === 0
        ? t.rMultiple < (upper ?? Number.POSITIVE_INFINITY)
        : t.rMultiple >= edge && (upper == null || t.rMultiple < upper);
    }).length,
  }));
  const max = Math.max(1, ...buckets.map((b) => b.count));
  return (
    <div className="flex h-40 items-end gap-1">
      {buckets.map((bucket) => (
        <div
          key={bucket.label}
          className="flex h-full flex-1 flex-col items-center justify-end gap-1"
        >
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {bucket.count || ""}
          </span>
          <div
            className={cn(
              "w-full rounded-t",
              bucket.negative ? "bg-red-500/70" : "bg-emerald-500/70",
            )}
            style={{ height: `${(bucket.count / max) * 100}%` }}
          />
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {bucket.label}
          </span>
        </div>
      ))}
    </div>
  );
}

function PnlByUnderlying({ result }: { result: TriangleBacktestResult }) {
  const rows = Object.entries(result.stats.byUnderlying).sort((a, b) => b[1].pnl - a[1].pnl);
  const max = Math.max(1, ...rows.map(([, r]) => Math.abs(r.pnl)));
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map(([symbol, row]) => (
        <div key={symbol} className="grid grid-cols-[52px_1fr_1fr_88px] items-center gap-2 text-xs">
          <span className="font-mono">{symbol}</span>
          <div className="flex h-2 justify-end">
            {row.pnl < 0 ? (
              <div
                className="h-2 rounded-l bg-red-500/70"
                style={{ width: `${(Math.abs(row.pnl) / max) * 100}%` }}
              />
            ) : null}
          </div>
          <div className="flex h-2">
            {row.pnl > 0 ? (
              <div
                className="h-2 rounded-r bg-emerald-500/70"
                style={{ width: `${(row.pnl / max) * 100}%` }}
              />
            ) : null}
          </div>
          <span className="text-right font-mono tabular-nums">
            {fmtUsd(row.pnl)} <span className="text-muted-foreground">({row.trades})</span>
          </span>
        </div>
      ))}
    </div>
  );
}

export function TrianglePanel() {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { mutate, data: result, error, isPending } = useTriangleBacktest();
  const set = (key: keyof FormState) => (value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const trades = result
    ? [...result.trades].sort((a, b) => a.entryDate.localeCompare(b.entryDate))
    : [];
  const selected = trades.find((t) => t.id === selectedId) ?? trades[0];

  return (
    <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>Ascending triangle → call</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Field
            label="Underlyings"
            hint="Daily bars; one position per underlying at a time"
            value={form.underlyings}
            onChange={set("underlyings")}
          />
          <Segmented
            label="Data feed"
            options={[
              { value: "sip", label: "SIP" },
              { value: "iex", label: "IEX" },
            ]}
            value={form.feed}
            onChange={(feed) => setForm((prev) => ({ ...prev, feed }))}
            hint="The volume filter wants the consolidated tape — IEX is ~4% of it."
          />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start" type="date" value={form.start} onChange={set("start")} />
            <Field label="End" type="date" value={form.end} onChange={set("end")} />
          </div>

          <Separator />
          <p className="text-[11px] text-muted-foreground">
            Pattern: a flat lid touched by ≥ N swing highs, a rising floor of higher lows, then the
            first close through the lid on above-average volume.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Min touches" value={form.minTouches} onChange={set("minTouches")} />
            <Field
              label="Touch tol. (%)"
              value={form.touchTolerancePct}
              onChange={set("touchTolerancePct")}
            />
            <Field
              label="Volume ×"
              hint="vs 20-day mean"
              value={form.volumeMultiple}
              onChange={set("volumeMultiple")}
            />
            <Field
              label="Min height (%)"
              value={form.minHeightPct}
              onChange={set("minHeightPct")}
            />
          </div>

          <Separator />
          <Segmented
            label="Structure"
            options={[
              { value: "bull_call_spread", label: "Call spread" },
              { value: "long_call", label: "Long call" },
            ]}
            value={form.structure}
            onChange={(structure) => setForm((prev) => ({ ...prev, structure }))}
            hint={
              form.structure === "bull_call_spread"
                ? "Short call on the measured-move target: the target and the spread's max value sit at the same price."
                : "Uncapped upside, full theta and vega on the whole premium."
            }
          />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Long delta" value={form.targetDelta} onChange={set("targetDelta")} />
            <Field label="DTE (days)" value={form.dteDays} onChange={set("dteDays")} />
          </div>

          <Separator />
          <Segmented
            label="Stop"
            options={[
              { value: "resistance", label: "Back under lid" },
              { value: "support", label: "Under floor" },
            ]}
            value={form.stopMode}
            onChange={(stopMode) => setForm((prev) => ({ ...prev, stopMode }))}
          />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Stop buffer (%)"
              value={form.stopBufferPct}
              onChange={set("stopBufferPct")}
            />
            <Field label="Max hold (d)" value={form.maxHoldDays} onChange={set("maxHoldDays")} />
          </div>

          <Separator />
          <p className="text-[11px] text-muted-foreground">
            The two knobs below are assumptions, not measurements: IV is realised vol × the
            multiplier, and friction is a share of each leg's model price.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="IV × realised" value={form.ivMultiplier} onChange={set("ivMultiplier")} />
            <Field
              label="Friction / leg (%)"
              value={form.frictionPct}
              onChange={set("frictionPct")}
            />
            <Field
              label="Risk / trade (%)"
              value={form.riskPerTradePct}
              onChange={set("riskPerTradePct")}
            />
            <Field
              label="Max positions"
              value={form.maxOpenPositions}
              onChange={set("maxOpenPositions")}
            />
          </div>

          <Button onClick={() => mutate(toParams(form))} disabled={isPending}>
            {isPending ? "Running…" : "Run backtest"}
          </Button>
          {error ? <p className="text-sm text-red-500">{(error as Error).message}</p> : null}
        </CardContent>
      </Card>

      <div className="flex min-w-0 flex-col gap-6">
        {!result ? (
          <Card>
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              Run a backtest to see the equity curve and every detected triangle.
              <br />
              <span className="text-xs">
                Model-priced options (Black-Scholes on realised vol) — evidence, not a forecast.
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
                    Run on the IEX feed (~4% of volume): the volume filter saw a different tape.
                    Treat this as a smoke test.
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
                    hint={`${fmtPct(result.stats.returnPct)} · ${result.params.benchmark} ${fmtPct(result.stats.benchmarkReturnPct ?? undefined)}`}
                  />
                  <Stat
                    label="CAGR / Sharpe"
                    value={`${fmtPct(result.stats.cagr ?? undefined)} / ${fmtNum(result.stats.sharpe ?? undefined)}`}
                  />
                  <Stat
                    label="Max drawdown"
                    value={fmtPct(result.stats.maxDrawdownPct)}
                    hint={`${fmtUsd(result.stats.maxDrawdown)} · ${result.params.benchmark} ${fmtPct(result.stats.benchmarkMaxDrawdownPct ?? undefined)}`}
                  />
                  <Stat
                    label="Trades"
                    value={String(result.stats.trades)}
                    hint={`${result.sessionsScanned} sessions · ${result.params.underlyings.length} symbols`}
                  />
                  <Stat
                    label="Payoff ratio"
                    value={fmtNum(result.stats.payoffRatio)}
                    hint={`avg win ${fmtUsd(result.stats.avgWin)} / loss ${fmtUsd(result.stats.avgLoss)}`}
                  />
                  <Stat
                    label="Expectancy"
                    value={fmtUsd(result.stats.expectancy)}
                    hint={`avg ${fmtNum(result.stats.avgR)} R per trade`}
                  />
                  <Stat
                    label="Reached target"
                    value={fmtPct(result.stats.targetReachedRate)}
                    hint="underlying hit R+H before exit"
                  />
                  <Stat
                    label="Avg hold"
                    value={`${fmtNum(result.stats.avgHoldingDays, 1)} d`}
                    hint={
                      Object.entries(result.stats.byExitReason)
                        .map(([k, v]) => `${k}:${v}`)
                        .join(" ") || "—"
                    }
                  />
                </div>
                <Separator />
                <Funnel result={result} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Equity vs {result.params.benchmark} buy &amp; hold</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <EquityCurve
                  points={result.equityCurve}
                  benchmark={result.benchmarkCurve}
                  baseline={result.params.initialEquity}
                />
                <div className="flex gap-4 text-[11px] text-muted-foreground">
                  <span>━ strategy (marked to model at each close)</span>
                  <span>┅ {result.params.benchmark} scaled to the same start</span>
                </div>
                <div>
                  <span className="text-xs font-medium">Drawdown from peak</span>
                  <DrawdownChart points={result.equityCurve} benchmark={result.benchmarkCurve} />
                </div>
              </CardContent>
            </Card>

            {selected ? (
              <Card>
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span>
                      {selected.underlying} · {selected.entryDate}
                    </span>
                    <span className="text-xs font-normal text-muted-foreground">
                      lid {fmtNum(selected.triangle.resistance)} · height{" "}
                      {fmtNum(selected.triangle.height)} · target {fmtNum(selected.triangle.target)}{" "}
                      · {selected.exitReason} after {selected.holdingDays} d ·{" "}
                      <span className={selected.pnl >= 0 ? "text-emerald-500" : "text-red-500"}>
                        {fmtUsd(selected.pnl)} ({fmtNum(selected.rMultiple)} R)
                      </span>
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <TriangleTradeChart
                    trade={selected}
                    bars={result.barsByUnderlying[selected.underlying] ?? []}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    ● amber: touches of the lid · ● blue: floor lows · lines: lid and floor
                    regression · dashed: target and stop. Click a trade below to redraw.
                  </p>
                </CardContent>
              </Card>
            ) : null}

            {trades.length > 0 ? (
              <div className="grid gap-6 xl:grid-cols-2">
                <Card>
                  <CardHeader>
                    <CardTitle>Outcome distribution (R)</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <RDistribution trades={trades} />
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>P&amp;L by underlying</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <PnlByUnderlying result={result} />
                  </CardContent>
                </Card>
              </div>
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
                <CardTitle>Trades</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Entry</TableHead>
                      <TableHead>Sym</TableHead>
                      <TableHead className="text-right">Strikes</TableHead>
                      <TableHead>Expiry</TableHead>
                      <TableHead className="text-right">Debit</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Hold</TableHead>
                      <TableHead>Exit</TableHead>
                      <TableHead className="text-right">P&amp;L</TableHead>
                      <TableHead className="text-right">R</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {trades.map((trade) => (
                      <TableRow
                        key={trade.id}
                        onClick={() => setSelectedId(trade.id)}
                        className={cn(
                          "cursor-pointer",
                          selected?.id === trade.id && "bg-primary/10",
                        )}
                      >
                        <TableCell className="font-mono text-xs">{trade.entryDate}</TableCell>
                        <TableCell className="font-mono text-xs">{trade.underlying}</TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {fmtNum(trade.longStrike)}
                          {trade.shortStrike != null ? `/${fmtNum(trade.shortStrike)}` : ""}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{trade.expiration}</TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {fmtNum(trade.entryDebit)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {trade.contracts}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">
                          {trade.holdingDays}d
                        </TableCell>
                        <TableCell className="text-xs">
                          <span
                            className="mr-1.5 inline-block size-2 rounded-full"
                            style={{ backgroundColor: EXIT_COLORS[trade.exitReason] }}
                          />
                          {trade.exitReason}
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
