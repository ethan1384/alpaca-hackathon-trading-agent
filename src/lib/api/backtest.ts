import type { BacktestParamsInput, BacktestResult } from "@/domain/backtest";

/** Run the ORB → 0DTE vertical backtest via `/api/backtest`. */
export async function runBacktestRequest(params: BacktestParamsInput): Promise<BacktestResult> {
  const response = await fetch("/api/backtest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Backtest failed");
  }
  return response.json() as Promise<BacktestResult>;
}
