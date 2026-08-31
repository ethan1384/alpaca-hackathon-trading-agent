"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchOptionExpirations } from "@/lib/api/options";

const VALID_UNDERLYING = /^[A-Za-z]{1,6}$/;

export function useOptionExpirations(underlying: string, enabled = true) {
  const symbol = underlying.toUpperCase();
  return useQuery({
    queryKey: ["option-expirations", symbol],
    enabled: enabled && VALID_UNDERLYING.test(symbol),
    queryFn: () => fetchOptionExpirations(symbol),
    staleTime: 5 * 60_000,
  });
}
