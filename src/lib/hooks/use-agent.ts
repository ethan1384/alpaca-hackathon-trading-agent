"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchAgentDecisions,
  fetchAgentReview,
  fetchAgentStatusWithMarks,
  runAgentCycleRequest,
} from "@/lib/api/agent";

export function useAgentStatus() {
  return useQuery({
    queryKey: ["agent", "status"],
    queryFn: fetchAgentStatusWithMarks,
    refetchInterval: 30_000,
  });
}

export function useAgentDecisions(limit = 50) {
  return useQuery({
    queryKey: ["agent", "decisions", limit],
    queryFn: () => fetchAgentDecisions(limit),
    refetchInterval: 30_000,
  });
}

export function useAgentReview(limit = 50) {
  return useQuery({
    queryKey: ["agent", "review", limit],
    queryFn: () => fetchAgentReview(limit),
    refetchInterval: 30_000,
  });
}

export function useRunAgentCycle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: runAgentCycleRequest,
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["agent"] });
      qc.invalidateQueries({ queryKey: ["trading"] });
    },
  });
}
