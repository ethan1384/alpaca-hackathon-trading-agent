import type { AgentCycleReport, AgentStatus } from "@/domain/agent";
import type { DecisionRecord } from "@/domain/decision";

async function json<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(data.error ?? `Request failed (${response.status})`);
  }
  return data;
}

export function fetchAgentStatus(): Promise<AgentStatus> {
  return fetch("/api/agent/status").then((r) => json<AgentStatus>(r));
}

export function fetchAgentStatusWithMarks(): Promise<AgentStatus> {
  return fetch("/api/agent/status?withMarks=true").then((r) => json<AgentStatus>(r));
}

export function fetchAgentDecisions(limit = 50): Promise<DecisionRecord[]> {
  return fetch(`/api/agent/decisions?limit=${limit}`)
    .then((r) => json<{ decisions: DecisionRecord[] }>(r))
    .then((d) => d.decisions);
}

export function fetchAgentReview(limit = 50): Promise<string> {
  return fetch(`/api/agent/decisions?limit=${limit}&format=review`)
    .then((r) => json<{ review: string }>(r))
    .then((d) => d.review);
}

export function runAgentCycleRequest(): Promise<AgentCycleReport> {
  return fetch("/api/agent/run", { method: "POST" }).then((r) => json<AgentCycleReport>(r));
}
