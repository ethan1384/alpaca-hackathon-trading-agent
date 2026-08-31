"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { AgentStatus } from "@/domain/agent";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

export function AgentConfigCard({ status }: { status: AgentStatus }) {
  const { config, competition, account, llm } = status;
  const phaseTone =
    competition.phase === "scoring"
      ? "success"
      : competition.phase === "pre"
        ? "secondary"
        : "warning";

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Agent — SPY put credit spread</CardTitle>
        <div className="flex gap-2">
          <Badge variant={status.enabled ? "success" : "danger"}>
            {status.enabled ? "enabled" : "disabled"}
          </Badge>
          <Badge variant={phaseTone}>{competition.phase}</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-2 sm:grid-cols-2">
        <Row label="Hours to snapshot" value={competition.hoursUntilSnapshot.toFixed(1)} />
        <Row
          label="Entry window"
          value={
            <Badge variant={competition.openingWindowOpen ? "success" : "secondary"}>
              {competition.openingWindowOpen ? "open" : "closed"}
            </Badge>
          }
        />
        <Row
          label="Entered today"
          value={
            <Badge variant={status.enteredToday ? "warning" : "secondary"}>
              {status.enteredToday ? "yes" : "no"}
            </Badge>
          }
        />
        <Row
          label="Account"
          value={
            <Badge variant={account.ok ? "success" : "danger"}>
              {account.ok ? (account.number ?? "ok") : "check"}
            </Badge>
          }
        />
        <div className="sm:col-span-2">
          <Separator className="my-2" />
        </div>
        <Row label="LLM model" value={llm.model} />
        <Row label="LLM endpoint" value={<span className="text-xs">{llm.baseUrl}</span>} />
        <Row label="Short delta / width" value={`${config.targetDelta} / $${config.spreadWidth}`} />
        <Row
          label="Target / stop"
          value={`${config.targetProfitPct * 100}% / ${config.stopMultiple}×`}
        />
        <Row
          label="Risk per spread"
          value={`${config.riskPerSidePct * 100}% · max ${config.maxConcurrentSpreads}`}
        />
        <Row
          label="Entry window (ET)"
          value={`${config.entryWindowEt.start}–${config.entryWindowEt.end}`}
        />
        {account.violations.length > 0 ? (
          <p className="sm:col-span-2 text-xs text-red-500">{account.violations.join("; ")}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
