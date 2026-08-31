"use client";

import { useQuery } from "@tanstack/react-query";
import type { Timeframe } from "@/domain/types";
import { fetchBars } from "@/lib/api/bars";
import { useMarketStore } from "@/lib/stores/market-store";

export function useBars(symbol: string, timeframe: Timeframe, enabled = true) {
  const setHistoricalBars = useMarketStore((state) => state.setHistoricalBars);

  return useQuery({
    queryKey: ["bars", symbol, timeframe],
    enabled: enabled && symbol.length > 0,
    queryFn: async () => {
      const data = await fetchBars(symbol, timeframe, 500);
      setHistoricalBars(symbol, data.bars);
      return data;
    },
  });
}
