"use client";

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
import { displayInstrumentLabel } from "@/domain/types";
import { useCloseAllPositions, useClosePosition, usePositions } from "@/lib/hooks/use-trading";
import { useUiStore } from "@/lib/stores/ui-store";
import { fmtNum, fmtPct, fmtUsd, plTone } from "./format";

export function PositionsTable() {
  const { data, error, isLoading } = usePositions();
  const closePosition = useClosePosition();
  const closeAll = useCloseAllPositions();
  const sendToTicket = useUiStore((state) => state.sendToTicket);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Positions {data ? `(${data.length})` : ""}</CardTitle>
        {data && data.length > 0 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={closeAll.isPending}
            onClick={() => closeAll.mutate()}
          >
            Close all
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-red-500">{(error as Error).message}</p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !data || data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No open positions.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead>Side</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Avg entry</TableHead>
                <TableHead className="text-right">Last</TableHead>
                <TableHead className="text-right">Mkt value</TableHead>
                <TableHead className="text-right">Unrealized P/L</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((p) => (
                <TableRow key={p.symbol}>
                  <TableCell className="font-medium">
                    <button
                      type="button"
                      className="text-left hover:underline"
                      title={p.symbol}
                      onClick={() =>
                        sendToTicket({
                          symbol: p.symbol,
                          side: p.side === "long" ? "sell" : "buy",
                        })
                      }
                    >
                      {displayInstrumentLabel(p.symbol)}
                    </button>
                  </TableCell>
                  <TableCell>
                    <Badge variant={p.side === "long" ? "success" : "danger"}>{p.side}</Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {fmtNum(p.qty, 4)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {fmtUsd(p.avgEntryPrice)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {fmtUsd(p.currentPrice)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {fmtUsd(p.marketValue)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Badge variant={plTone(p.unrealizedPl)}>
                      {fmtUsd(p.unrealizedPl)} ({fmtPct(p.unrealizedPlpc)})
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={closePosition.isPending}
                      onClick={() => closePosition.mutate({ symbol: p.symbol })}
                    >
                      Close
                    </Button>
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
