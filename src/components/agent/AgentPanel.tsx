"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAgentStatus, useRunAgentCycle } from "@/lib/hooks/use-agent";
import { AgentConfigCard } from "./AgentConfigCard";
import { AgentLiveView } from "./AgentLiveView";
import { DecisionTimeline } from "./DecisionTimeline";
import { ManagedSpreadsTable } from "./ManagedSpreadsTable";

const AUTO_RUN_MS = 60_000;

export function AgentPanel() {
  const status = useAgentStatus();
  const runCycle = useRunAgentCycle();
  const [auto, setAuto] = useState(false);
  const report = runCycle.data;

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => {
      if (!runCycle.isPending) runCycle.mutate();
    }, AUTO_RUN_MS);
    return () => clearInterval(id);
  }, [auto, runCycle]);

  return (
    <section className="flex flex-col gap-6">
      <AgentLiveView
        status={status.data}
        running={runCycle.isPending}
        auto={auto}
        onToggleAuto={() => setAuto((v) => !v)}
        onRun={() => runCycle.mutate()}
        lastCycleAt={report?.at}
      />

      {status.error ? (
        <p className="text-sm text-red-500">{(status.error as Error).message}</p>
      ) : status.data ? (
        <AgentConfigCard status={status.data} />
      ) : (
        <p className="text-sm text-muted-foreground">Loading agent status…</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Last cycle report</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            The official competition run is an external cron hitting{" "}
            <code>POST /api/agent/run</code> every minute during the scoring window — this in-tab
            timer is for local monitoring only.
          </p>
          {runCycle.error ? (
            <p className="text-sm text-red-500">{(runCycle.error as Error).message}</p>
          ) : null}
          {report ? (
            <div className="flex flex-col gap-2 rounded border border-input p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{report.phase}</Badge>
                <span className="text-muted-foreground">
                  {report.entry.evaluated
                    ? report.entry.acted
                      ? `entered — order ${report.entry.orderId}`
                      : `no entry — ${report.entry.skipped ?? report.entry.error ?? "skipped"}`
                    : `entry not evaluated — ${report.entry.reason}`}
                </span>
              </div>
              {report.managed.length > 0 ? (
                <ul className="text-xs text-muted-foreground">
                  {report.managed.map((m) => (
                    <li key={m.id}>
                      {m.id}: {m.zone} → {m.action}
                      {m.error ? ` (${m.error})` : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
              {report.errors.length > 0 ? (
                <p className="text-xs text-red-500">{report.errors.join("; ")}</p>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {status.data ? <ManagedSpreadsTable status={status.data} /> : null}
      <DecisionTimeline />
    </section>
  );
}
