"use client";

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { type ChartPriceLine, PriceChart } from "@/components/dashboard/PriceChart";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AGENT } from "@/config/agent";
import { easternDate } from "@/config/competition";
import type { AgentStatus } from "@/domain/agent";
import { spreadEntryCredit } from "@/domain/agent";
import type { DecisionRecord } from "@/domain/decision";
import { deriveAgentPhase, formatMinutes } from "@/lib/agent-phase";
import { fetchBars } from "@/lib/api/bars";
import { postSubscription } from "@/lib/api/subscriptions";
import { mergeTrailingBars } from "@/lib/bars-merge";
import { classifyDecision, DECISION_MARKER_STYLES, decisionMarkers } from "@/lib/decision-markers";
import { useAgentDecisions } from "@/lib/hooks/use-agent";
import { useConfigStore } from "@/lib/stores/config-store";
import { useMarketStore } from "@/lib/stores/market-store";
import { cn } from "@/lib/utils";
import { AgentPipeline, TONE_CLASSES } from "./AgentPipeline";

/**
 * The cockpit: the underlying's live tape, the agent's decisions plotted on it,
 * and the state the next cycle will branch into.
 *
 * Everything here is a *read* of state the agent already publishes — the phase
 * comes from `deriveAgentPhase` (pure), the marks from
 * `GET /api/agent/status?withMarks=true`, the markers from the [O5] decision
 * log. Nothing in this component can move an order; the run controls are owned
 * by `AgentPanel` and passed down so a single cycle timer exists.
 */

interface AgentLiveViewProps {
  status?: AgentStatus;
  running: boolean;
  auto: boolean;
  onToggleAuto: () => void;
  onRun: () => void;
  /** ISO timestamp of the last completed cycle, when one has run this session. */
  lastCycleAt?: string;
}

/** Countdown/clock refresh — the phase is re-derived on every tick. */
const TICK_MS = 15_000;

function useTicker(intervalMs: number): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return tick;
}

function money(value: number | null | undefined, digits = 2): string {
  return value == null ? "—" : value.toFixed(digits);
}

/** The one-line "why" behind a decision, whichever field carries it. */
function decisionReason(decision: DecisionRecord): string {
  if (decision.chosen?.reason) {
    return decision.chosen.reason;
  }
  const rejected = decision.rejected.at(-1);
  if (rejected) {
    return rejected.why;
  }
  return decision.outcome.error ?? "—";
}

export function AgentLiveView({
  status,
  running,
  auto,
  onToggleAuto,
  onRun,
  lastCycleAt,
}: AgentLiveViewProps) {
  const tick = useTicker(TICK_MS);
  const underlying = status?.config.underlying ?? AGENT.underlying;
  const dataFeed = useConfigStore((state) => state.dataFeed);
  const testFeed = dataFeed === "test";

  const connectionState = useMarketStore((state) => state.connectionState);
  const liveBars = useMarketStore((state) => state.bySymbol[underlying]?.bars);
  const lastTrade = useMarketStore((state) => state.bySymbol[underlying]?.lastTrade);
  const lastQuote = useMarketStore((state) => state.bySymbol[underlying]?.lastQuote);

  // The cockpit needs the underlying on the wire even when it is not on the
  // watchlist. Additive only — unsubscribing here would yank a symbol the user
  // may have added in the Market tab.
  useEffect(() => {
    postSubscription("add", [underlying]).catch(() => {
      // Best effort: the hub may already be at its subscription cap.
    });
  }, [underlying]);

  const history = useQuery({
    queryKey: ["agent-live-bars", underlying],
    // Wide enough that a weekend or an overnight still returns the previous
    // session — `lookbackStart` inflates the window ~4x for closed hours.
    queryFn: () => fetchBars(underlying, "1Min", 1500),
    refetchInterval: 5 * 60_000,
  });

  const decisions = useAgentDecisions(50);

  const bars = useMemo(() => {
    const historical = history.data?.bars ?? [];
    // The test WebSocket emits synthetic bars; REST still maps test → IEX.
    // Merging the two makes SPY look nothing like Alpaca's dashboard.
    if (testFeed) {
      return historical;
    }
    return mergeTrailingBars(historical, liveBars ?? []);
  }, [history.data, liveBars, testFeed]);

  /**
   * Trim to the latest ET session on the tape. Out of hours that is the
   * previous session rather than today's — the header says which, so an empty
   * overnight chart never reads as a live one.
   */
  const { sessionBars, sessionDate } = useMemo(() => {
    const last = bars.at(-1);
    if (!last) {
      return { sessionBars: bars, sessionDate: null as string | null };
    }
    const session = easternDate(new Date(last.timestamp));
    return {
      sessionBars: bars.filter((bar) => easternDate(new Date(bar.timestamp)) === session),
      sessionDate: session,
    };
  }, [bars]);

  const isTodaysSession = sessionDate != null && sessionDate === easternDate(new Date(tick));

  const markers = useMemo(
    () => decisionMarkers(decisions.data ?? [], sessionBars),
    [decisions.data, sessionBars],
  );

  const priceLines = useMemo<ChartPriceLine[]>(
    () =>
      (status?.spreads ?? []).flatMap((spread) => [
        ...(spread.entrySpot != null
          ? [
              {
                price: spread.entrySpot,
                color: "#22c55e",
                title: `ENTRY SPOT ${spread.entrySpot.toFixed(2)}`,
                dashed: true,
              },
            ]
          : []),
        {
          price: spread.shortStrike,
          color: "#f59e0b",
          title: `SHORT ${spread.shortStrike}P`,
          dashed: true,
        },
        {
          price: spread.longStrike,
          color: "#64748b",
          title: `LONG ${spread.longStrike}P`,
          dashed: true,
        },
      ]),
    [status?.spreads],
  );

  const phase = useMemo(
    () => deriveAgentPhase({ status, running, now: new Date(tick) }),
    [status, running, tick],
  );
  const palette = TONE_CLASSES[phase.tone];

  const lastBar = sessionBars.at(-1);
  const spot = lastTrade?.price ?? lastQuote?.askPrice ?? lastBar?.close;
  const sessionOpen = sessionBars[0]?.open;
  const change = spot != null && sessionOpen != null ? spot - sessionOpen : undefined;
  const changePct = change != null && sessionOpen ? (change / sessionOpen) * 100 : undefined;

  const feed = useMemo(() => [...(decisions.data ?? [])].reverse().slice(0, 8), [decisions.data]);
  const lastLlm = useMemo(
    () => [...(decisions.data ?? [])].reverse().find((d) => d.llm),
    [decisions.data],
  );
  const mark = status?.marks?.[0];
  const openSpread = useMemo(
    () => (mark ? status?.spreads.find((s) => s.id === mark.id) : status?.spreads[0]),
    [mark, status?.spreads],
  );

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="relative mt-1.5 flex h-3 w-3 shrink-0">
            {phase.live ? (
              <span
                className={cn(
                  "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
                  palette.dot,
                )}
              />
            ) : null}
            <span className={cn("relative inline-flex h-3 w-3 rounded-full", palette.dot)} />
          </span>
          <div>
            <CardTitle className={cn("text-lg", palette.text)}>{phase.label}</CardTitle>
            <p className="mt-0.5 max-w-xl text-sm text-muted-foreground">{phase.detail}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={connectionState === "connected" ? "success" : "warning"}>
            feed {connectionState}
          </Badge>
          <Button size="sm" variant={auto ? "default" : "outline"} onClick={onToggleAuto}>
            {auto ? "Auto-run: on" : "Auto-run: off"}
          </Button>
          <Button size="sm" disabled={running} onClick={onRun}>
            {running ? "Running…" : "Run cycle"}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
          <span>
            model <span className="font-medium text-foreground">{status?.llm.model ?? "—"}</span>
          </span>
          <span>
            phase{" "}
            <span className="font-medium text-foreground">{status?.competition.phase ?? "—"}</span>
          </span>
          <span>
            equity{" "}
            <span className="font-medium text-foreground">
              {status ? `$${status.account.equity.toLocaleString("en-US")}` : "—"}
            </span>
          </span>
          {phase.nextEventInMinutes != null ? (
            <span>
              <span className={cn("font-medium", palette.text)}>
                {formatMinutes(phase.nextEventInMinutes)}
              </span>{" "}
              {phase.nextEventLabel}
            </span>
          ) : null}
          <span>
            last cycle{" "}
            <span className="font-medium text-foreground">
              {lastCycleAt ? new Date(lastCycleAt).toLocaleTimeString() : "not run yet"}
            </span>
          </span>
        </div>

        <AgentPipeline step={phase.step} tone={phase.tone} live={phase.live} />

        <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
          <div className="rounded-md border border-input p-3">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <div className="flex items-baseline gap-3">
                <span className="text-sm font-semibold">{underlying}</span>
                <span className="text-xl font-bold tabular-nums">{money(spot)}</span>
                {changePct != null ? (
                  <span
                    className={cn(
                      "text-xs font-medium tabular-nums",
                      change != null && change >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-red-600 dark:text-red-400",
                    )}
                  >
                    {change != null && change >= 0 ? "+" : ""}
                    {money(change)} ({changePct.toFixed(2)}%)
                  </span>
                ) : null}
              </div>
              <span className="text-[11px] text-muted-foreground">
                {sessionDate == null
                  ? "1-min tape"
                  : isTodaysSession
                    ? `live 1-min tape · ${sessionDate} ET`
                    : `last session · ${sessionDate} ET`}{" "}
                · {sessionBars.length} bars · {markers.length} agent marks
                {testFeed
                  ? " · feed test (REST IEX only — set ALPACA_DATA_FEED=iex for live SPY)"
                  : ""}
              </span>
            </div>

            {history.isError ? (
              <p className="py-10 text-center text-sm text-red-500">
                {(history.error as Error).message}
              </p>
            ) : sessionBars.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Waiting for {underlying} bars…
              </p>
            ) : (
              <PriceChart
                bars={sessionBars}
                height={320}
                intraday
                showVolume
                showLegend
                markers={markers}
                priceLines={priceLines}
              />
            )}

            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              {Object.entries(DECISION_MARKER_STYLES).map(([kind, style]) => (
                <span key={kind} className="flex items-center gap-1.5">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: style.color }}
                  />
                  {style.label} — {style.legend}
                </span>
              ))}
              {priceLines.length > 0 ? (
                <>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-px w-4 bg-emerald-500" />
                    dashed green — underlying spot at entry
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-px w-4 bg-amber-500" />
                    dashed amber/grey — short / long strikes
                  </span>
                </>
              ) : null}
            </div>
          </div>

          <div className="flex flex-col gap-4">
            <div className="rounded-md border border-input p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Last model call
              </p>
              {running ? (
                <p className={cn("mt-2 animate-pulse text-sm", palette.text)}>
                  Prompting {status?.llm.model ?? "the model"}…
                </p>
              ) : lastLlm ? (
                <>
                  <p className="mt-2 text-sm leading-snug">{decisionReason(lastLlm)}</p>
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {lastLlm.llm?.model}
                    {lastLlm.llm?.latencyMs != null ? ` · ${lastLlm.llm.latencyMs}ms` : ""}
                    {lastLlm.llm?.outputTokens != null
                      ? ` · ${lastLlm.llm.outputTokens} out-tokens`
                      : ""}
                    {" · "}
                    {new Date(lastLlm.at).toLocaleTimeString()}
                  </p>
                </>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  The model has not been consulted yet — it is only called for the entry veto and
                  the dead-zone exit.
                </p>
              )}
            </div>

            {mark && openSpread ? (
              <div className="rounded-md border border-input p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Open spread
                </p>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">entry credit</dt>
                  <dd className="text-right tabular-nums">
                    {money(spreadEntryCredit(openSpread))}
                    {openSpread.filledCredit != null &&
                    openSpread.filledCredit !== openSpread.credit
                      ? ` (limit ${openSpread.credit.toFixed(2)})`
                      : ""}
                  </dd>
                  {openSpread.entrySpot != null ? (
                    <>
                      <dt className="text-muted-foreground">entry spot</dt>
                      <dd className="text-right tabular-nums">{money(openSpread.entrySpot)}</dd>
                    </>
                  ) : null}
                  <dt className="text-muted-foreground">zone</dt>
                  <dd className="text-right font-medium">{mark.zone}</dd>
                  <dt className="text-muted-foreground">buyback</dt>
                  <dd className="text-right tabular-nums">{money(mark.buyback)}</dd>
                  <dt className="text-muted-foreground">% of credit</dt>
                  <dd className="text-right tabular-nums">
                    {mark.pnlPctOfCredit == null
                      ? "—"
                      : `${(mark.pnlPctOfCredit * 100).toFixed(0)}%`}
                  </dd>
                  <dt className="text-muted-foreground">to short strike</dt>
                  <dd className="text-right tabular-nums">
                    {mark.distanceToShortPct == null
                      ? "—"
                      : `${(mark.distanceToShortPct * 100).toFixed(2)}%`}
                  </dd>
                  <dt className="text-muted-foreground">to expiry</dt>
                  <dd className="text-right tabular-nums">{formatMinutes(mark.minutesToExpiry)}</dd>
                </dl>
              </div>
            ) : null}

            <div className="flex min-h-0 flex-col rounded-md border border-input p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Decision stream
              </p>
              {feed.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">No decisions recorded yet.</p>
              ) : (
                <ul className="mt-2 flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
                  {feed.map((decision) => {
                    const style = DECISION_MARKER_STYLES[classifyDecision(decision)];
                    return (
                      <li
                        key={decision.id}
                        className="border-l-2 pl-2"
                        style={{ borderColor: style.color }}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span
                            className="text-[11px] font-semibold uppercase tracking-wide"
                            style={{ color: style.color }}
                          >
                            {style.label}
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            {new Date(decision.at).toLocaleTimeString()}
                          </span>
                        </div>
                        <p className="text-xs leading-snug text-muted-foreground">
                          {decisionReason(decision)}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
