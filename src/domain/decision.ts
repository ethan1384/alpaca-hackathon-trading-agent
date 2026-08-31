import type { RiskVerdict } from "@/config/risk";

/**
 * [O5] decision-log record shapes. Pure types only — the writer, the JSONL sink
 * and the in-memory ring live in `src/server/risk/decision-log.ts` (server-only).
 * Split out here so the client (the Agent tab) and other pure modules can type
 * the payload without importing a server module.
 */

export type DecisionOutcome = "submitted" | "blocked" | "no-trade" | "error";

/** One alternative the agent considered and did not take. */
export interface RejectedAlternative {
  /** The structure/contract considered, e.g. "SPY 09/02 bull_put_spread 500/495". */
  what: string;
  /** Why it lost — a concrete reason, not "worse score". */
  why: string;
}

export interface DecisionRecord {
  id: string;
  at: string;
  strategy: string;
  underlying: string;
  /** What caused this evaluation to run at all. */
  trigger: { kind: string; detail?: string };
  /** The structure actually chosen. `null` when the agent decided not to act. */
  chosen: {
    kind: string;
    legs: string[];
    contracts: number;
    entryLimit?: number;
    reason: string;
    confidence?: number;
  } | null;
  /** [O5]'s load-bearing field. */
  rejected: RejectedAlternative[];
  /** Every guardrail verdict that ran, verbatim — including the ones that passed. */
  guardrails: Record<string, RiskVerdict | undefined>;
  sizing: {
    contracts: number;
    riskAmount: number | null;
    pctOfEquity: number | null;
  } | null;
  outcome: {
    status: DecisionOutcome;
    orderId?: string;
    error?: string;
  };
  /** Present when an LLM produced the decision. Cost/latency accounting. */
  llm?: {
    model: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    latencyMs?: number;
    /**
     * The exact user prompt the model saw and the raw text it replied with —
     * kept verbatim so a reviewer can reconstruct *why* the model decided what
     * it did, not just that it did. The system prompt is a code constant
     * (`ENTRY_SYSTEM_PROMPT` / `MANAGE_SYSTEM_PROMPT`) and is not duplicated here.
     */
    prompt?: string;
    response?: string;
  };
}

export type DecisionDraft = Omit<DecisionRecord, "id" | "at"> &
  Partial<Pick<DecisionRecord, "id" | "at">>;
