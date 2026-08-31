"use client";

import { useMutation } from "@tanstack/react-query";
import type { CreditBacktestParamsInput } from "@/domain/backtest-credit";
import { runCreditBacktestRequest } from "@/lib/api/backtest-credit";

/** A one-shot command, like `useBacktest` — a mutation so a re-run always re-runs. */
export function useCreditBacktest() {
  return useMutation({
    mutationFn: (params: CreditBacktestParamsInput) => runCreditBacktestRequest(params),
  });
}
