import type {
  TriangleBacktestParamsInput,
  TriangleBacktestResult,
} from "@/domain/backtest-triangle";

/** Run the ascending-triangle breakout backtest via `/api/backtest/triangle`. */
export async function runTriangleBacktestRequest(
  params: TriangleBacktestParamsInput,
): Promise<TriangleBacktestResult> {
  const response = await fetch("/api/backtest/triangle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Backtest failed");
  }
  return response.json() as Promise<TriangleBacktestResult>;
}
