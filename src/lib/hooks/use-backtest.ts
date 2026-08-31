"use client";

import { useMutation } from "@tanstack/react-query";
import type { BacktestParamsInput } from "@/domain/backtest";
import { runBacktestRequest } from "@/lib/api/backtest";

/**
 * A backtest is a one-shot command, not cached server state — a mutation, so
 * re-running with the same parameters always re-runs rather than replaying a
 * cache entry.
 */
export function useBacktest() {
  return useMutation({
    mutationFn: (params: BacktestParamsInput) => runBacktestRequest(params),
  });
}
