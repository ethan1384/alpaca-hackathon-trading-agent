"use client";

import { AccountSummary } from "./AccountSummary";
import { OrdersTable } from "./OrdersTable";
import { OrderTicket } from "./OrderTicket";
import { PositionsTable } from "./PositionsTable";

/**
 * Full manual trading surface: account snapshot, order ticket (market / limit /
 * stop / stop-limit / trailing-stop, with optional bracket TP/SL), open
 * positions and orders with inline close/cancel. The same actions are exposed to
 * AI agents over MCP at `/api/mcp`.
 */
export function TradingPanel() {
  return (
    <section className="flex flex-col gap-6">
      <AccountSummary />
      <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
        <OrderTicket />
        <div className="flex flex-col gap-6">
          <PositionsTable />
          <OrdersTable />
        </div>
      </div>
    </section>
  );
}
