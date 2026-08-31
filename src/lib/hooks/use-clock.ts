"use client";

import { useQuery } from "@tanstack/react-query";
import type { ClockResponseBody } from "@/domain/sse-events";

async function fetchClock(): Promise<ClockResponseBody> {
  const response = await fetch("/api/clock");
  if (!response.ok) {
    throw new Error("Failed to fetch market clock");
  }
  return response.json() as Promise<ClockResponseBody>;
}

export function useClock() {
  return useQuery({
    queryKey: ["clock"],
    queryFn: fetchClock,
    refetchInterval: (query) => {
      const data = query.state.data;
      return data?.isOpen ? 60_000 : 15_000;
    },
  });
}
