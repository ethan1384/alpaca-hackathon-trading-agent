"use client";

import { fmtPct } from "@/components/trading/format";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AgentStatus, SpreadZone } from "@/domain/agent";
import { spreadEntryCredit } from "@/domain/agent";

const ZONE_TONE: Record<SpreadZone, "success" | "danger" | "warning" | "secondary"> = {
  comfortable: "success",
  dead_zone: "warning",
  profit_target: "success",
  stop: "danger",
  time_close: "secondary",
  deadline: "danger",
};

export function ManagedSpreadsTable({ status }: { status: AgentStatus }) {
  const marks = new Map((status.marks ?? []).map((m) => [m.id, m]));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Managed spreads ({status.spreads.length})</CardTitle>
      </CardHeader>
      <CardContent>
        {status.spreads.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open agent positions.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Spread</TableHead>
                <TableHead className="text-right">Contracts</TableHead>
                <TableHead className="text-right">Credit</TableHead>
                <TableHead className="text-right">Entry spot</TableHead>
                <TableHead className="text-right">Buyback</TableHead>
                <TableHead className="text-right">P&L vs credit</TableHead>
                <TableHead className="text-right">Dist. to short</TableHead>
                <TableHead>Zone</TableHead>
                <TableHead>Last LLM</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {status.spreads.map((s) => {
                const m = marks.get(s.id);
                return (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">
                      {s.shortStrike}/{s.longStrike}p · {s.expiration}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{s.contracts}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {spreadEntryCredit(s).toFixed(2)}
                      {s.filledCredit != null && s.filledCredit !== s.credit
                        ? ` (${s.credit.toFixed(2)} lim.)`
                        : ""}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.entrySpot == null ? "—" : s.entrySpot.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {m?.buyback == null ? "—" : m.buyback.toFixed(2)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {m?.pnlPctOfCredit == null ? "—" : fmtPct(m.pnlPctOfCredit)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {m?.distanceToShortPct == null ? "—" : fmtPct(m.distanceToShortPct)}
                    </TableCell>
                    <TableCell>
                      {m ? (
                        <Badge variant={ZONE_TONE[m.zone]}>{m.zone}</Badge>
                      ) : (
                        <Badge variant="secondary">{s.status}</Badge>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground">
                      {s.lastLlm ? `${s.lastLlm.action}: ${s.lastLlm.reason}` : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
