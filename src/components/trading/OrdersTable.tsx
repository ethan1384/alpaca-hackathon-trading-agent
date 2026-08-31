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
import type { TradingOrder } from "@/domain/trading";
import { displayInstrumentLabel } from "@/domain/types";
import { useCancelAllOrders, useCancelOrder, useOrders } from "@/lib/hooks/use-trading";
import { cn } from "@/lib/utils";
import { fmtNum, fmtUsd } from "./format";

const OPEN_STATUSES = new Set([
  "new",
  "accepted",
  "partially_filled",
  "pending_new",
  "held",
  "replaced",
]);

function statusVariant(status: string) {
  if (status === "filled") return "success" as const;
  if (status === "canceled" || status === "expired" || status === "rejected")
    return "danger" as const;
  return "secondary" as const;
}

/**
 * Alpaca returns an `mleg` parent with an empty `symbol` and no `side` — the
 * contracts live on `legs`. Build the parent's label from them so a spread /
 * straddle does not render as a blank row.
 */
function orderLabel(order: TradingOrder): string {
  if (order.symbol) {
    return displayInstrumentLabel(order.symbol);
  }
  const legs = order.legs ?? [];
  if (legs.length === 0) {
    return "—";
  }
  return legs.map((leg) => `${leg.side} ${displayInstrumentLabel(leg.symbol)}`).join(" / ");
}

function priceCell(order: TradingOrder): string {
  if (order.type === "limit") return `lmt ${fmtUsd(order.limitPrice)}`;
  if (order.type === "stop") return `stp ${fmtUsd(order.stopPrice)}`;
  if (order.type === "stop_limit")
    return `${fmtUsd(order.stopPrice)} / ${fmtUsd(order.limitPrice)}`;
  if (order.type === "trailing_stop")
    return order.trailPercent
      ? `trail ${order.trailPercent}%`
      : `trail ${fmtUsd(order.trailPrice)}`;
  return "mkt";
}

export function OrdersTable() {
  const [status, setStatus] = useState<"open" | "closed" | "all">("open");
  const { data, error, isLoading } = useOrders(status);
  const cancelOrder = useCancelOrder();
  const cancelAll = useCancelAllOrders();

  const rows = data ?? [];
  const hasOpen = rows.some((o) => OPEN_STATUSES.has(o.status));

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>Orders</CardTitle>
        <div className="flex items-center gap-2">
          <span className="inline-flex overflow-hidden rounded border border-input text-xs">
            {(["open", "closed", "all"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                className={cn(
                  "px-2 py-1 capitalize transition-colors",
                  status === s ? "bg-primary text-primary-foreground" : "hover:bg-accent",
                )}
              >
                {s}
              </button>
            ))}
          </span>
          {hasOpen ? (
            <Button
              size="sm"
              variant="outline"
              disabled={cancelAll.isPending}
              onClick={() => cancelAll.mutate()}
            >
              Cancel all
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-red-500">{(error as Error).message}</p>
        ) : isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No {status} orders.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Symbol</TableHead>
                <TableHead>Side</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Filled</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((o) => (
                <TableRow key={o.id}>
                  <TableCell className="font-medium">
                    <span title={o.symbol || o.legs?.map((l) => l.symbol).join(" / ")}>
                      {orderLabel(o)}
                    </span>
                    {o.orderClass && o.orderClass !== "simple" ? (
                      <span className="ml-1 text-xs text-muted-foreground">{o.orderClass}</span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {o.side ? (
                      <Badge variant={o.side === "buy" ? "success" : "danger"}>{o.side}</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">multi</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs">{o.type}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {o.qty !== undefined ? fmtNum(o.qty, 4) : fmtUsd(o.notional)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {fmtNum(o.filledQty, 4)}
                    {o.filledAvgPrice ? ` @ ${fmtUsd(o.filledAvgPrice)}` : ""}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {priceCell(o)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(o.status)}>{o.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {OPEN_STATUSES.has(o.status) ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={cancelOrder.isPending}
                        onClick={() => cancelOrder.mutate(o.id)}
                      >
                        Cancel
                      </Button>
                    ) : null}
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
