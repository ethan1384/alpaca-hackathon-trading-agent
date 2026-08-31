"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DecisionOutcome, DecisionRecord } from "@/domain/decision";
import { useAgentDecisions, useAgentReview } from "@/lib/hooks/use-agent";

const OUTCOME_TONE: Record<DecisionOutcome, "success" | "danger" | "warning" | "secondary"> = {
  submitted: "success",
  blocked: "danger",
  error: "danger",
  "no-trade": "secondary",
};

export function DecisionTimeline() {
  const [showReview, setShowReview] = useState(false);
  const decisions = useAgentDecisions(50);
  const review = useAgentReview(50);

  const rows = [...(decisions.data ?? [])].reverse();

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Decision log</CardTitle>
        <Button size="sm" variant="outline" onClick={() => setShowReview((v) => !v)}>
          {showReview ? "Table view" : "AI-readable export"}
        </Button>
      </CardHeader>
      <CardContent>
        {showReview ? (
          <pre className="max-h-[420px] overflow-auto rounded bg-muted p-3 text-xs">
            {review.data || "(no decisions yet)"}
          </pre>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No decisions recorded yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Chosen</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Model</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((d: DecisionRecord) => (
                <TableRow key={d.id}>
                  <TableCell className="whitespace-nowrap text-xs">
                    {new Date(d.at).toLocaleTimeString()}
                  </TableCell>
                  <TableCell className="text-xs">
                    {d.trigger.kind}
                    {d.trigger.detail ? `/${d.trigger.detail}` : ""}
                  </TableCell>
                  <TableCell className="text-xs">
                    {d.chosen ? `${d.chosen.kind} ×${d.chosen.contracts}` : "no trade"}
                  </TableCell>
                  <TableCell className="max-w-[280px] truncate text-xs text-muted-foreground">
                    {d.chosen?.reason ?? d.rejected.map((r) => r.why).join("; ") ?? "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={OUTCOME_TONE[d.outcome.status]}>{d.outcome.status}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {d.llm?.model ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
