import type { BarsResponseBody } from "@/domain/sse-events";
import type { Timeframe } from "@/domain/types";

/** Fetch historical bars from `/api/bars`. Works for stock, crypto and option (OCC) symbols. */
export async function fetchBars(
  symbol: string,
  timeframe: Timeframe,
  limit: number,
): Promise<BarsResponseBody> {
  const params = new URLSearchParams({
    symbol,
    timeframe,
    limit: String(limit),
  });
  const response = await fetch(`/api/bars?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch bars for ${symbol}`);
  }
  return response.json() as Promise<BarsResponseBody>;
}
