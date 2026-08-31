import type { CreditBacktestParamsInput, CreditBacktestResult } from "@/domain/backtest-credit";

/** Run the short-credit-spread backtest via `/api/backtest/credit`. */
export async function runCreditBacktestRequest(
  params: CreditBacktestParamsInput,
): Promise<CreditBacktestResult> {
  const response = await fetch("/api/backtest/credit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Backtest failed");
  }
  return response.json() as Promise<CreditBacktestResult>;
}
