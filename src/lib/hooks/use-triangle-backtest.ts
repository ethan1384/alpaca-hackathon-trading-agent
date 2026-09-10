"use client";

import { useMutation } from "@tanstack/react-query";
import type { TriangleBacktestParamsInput } from "@/domain/backtest-triangle";
import { runTriangleBacktestRequest } from "@/lib/api/backtest-triangle";

/** A one-shot command, like `useBacktest` — re-running always re-runs. */
export function useTriangleBacktest() {
  return useMutation({
    mutationFn: (params: TriangleBacktestParamsInput) => runTriangleBacktestRequest(params),
  });
}
