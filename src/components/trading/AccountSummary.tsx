"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAccount } from "@/lib/hooks/use-trading";
import { fmtUsd } from "./format";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

export function AccountSummary() {
  const { data, error, isLoading } = useAccount();

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Account</CardTitle>
        {data ? (
          <span className="text-xs text-muted-foreground">
            {data.status} · #{data.accountNumber}
          </span>
        ) : null}
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-red-500">{(error as Error).message}</p>
        ) : isLoading || !data ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Equity" value={fmtUsd(data.equity)} />
            <Stat label="Cash" value={fmtUsd(data.cash)} />
            <Stat label="Buying power" value={fmtUsd(data.buyingPower)} />
            <Stat label="Long MV" value={fmtUsd(data.longMarketValue)} />
            <Stat label="Short MV" value={fmtUsd(data.shortMarketValue)} />
            <Stat
              label="Day P/L"
              value={fmtUsd(
                data.lastEquity !== undefined ? data.equity - data.lastEquity : undefined,
              )}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
