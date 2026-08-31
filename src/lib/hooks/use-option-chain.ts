"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchOptionChain, type OptionChainArgs } from "@/lib/api/options";

const VALID_UNDERLYING = /^[A-Za-z]{1,6}$/;

export function useOptionChain(args: OptionChainArgs, enabled = true) {
  const symbol = args.underlying.toUpperCase();
  return useQuery({
    queryKey: [
      "option-chain",
      symbol,
      args.expiration,
      args.type ?? "all",
      args.strikeGte ?? null,
      args.strikeLte ?? null,
      args.moneyness ?? null,
    ],
    enabled: enabled && VALID_UNDERLYING.test(symbol) && args.expiration.length === 10,
    queryFn: () => fetchOptionChain({ ...args, underlying: symbol }),
    staleTime: 15_000,
    // The `indicative` feed is ~15 min delayed, so sub-30s polling buys nothing.
    refetchInterval: (query) => (query.state.data ? 30_000 : false),
    placeholderData: (previous) => previous,
  });
}
