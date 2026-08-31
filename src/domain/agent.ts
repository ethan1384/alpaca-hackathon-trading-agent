import type { AgentConfig } from "@/config/agent";
import type { CompetitionPhase, CompetitionStatus } from "@/config/competition";
import type { DecisionRecord } from "./decision";

/**
 * Shapes for the LLM decision agent (`src/server/agent/`, docs/08-agent.md).
 * Pure types only — shared by the server modules and the client (the Agent
 * tab), so the browser never imports a `server-only` file.
 */

// --- Working memory (`${AGENT_LOG_DIR}/agent-state.json`) -----------------

/** Which mechanical / LLM check a close was triggered by. */
export type SpreadZone =
  | "deadline" // pre-snapshot forced close — mechanical
  | "stop" // buyback >= stopMultiple * credit — mechanical
  | "profit_target" // buyback <= targetProfitPct * credit — mechanical
  | "time_close" // expiry-session time-close — mechanical
  | "dead_zone" // losing + near the short strike or low on time — ask the LLM
  | "comfortable"; // hold, no LLM

export type ManagedSpreadStatus = "open" | "closing" | "closed";

export interface ManagedSpreadLlmNote {
  at: string;
  action: string;
  reason: string;
  urgency?: string;
}

/** One credit spread the agent opened and is responsible for exiting. */
export interface ManagedSpread {
  /** Deterministic: `agent-entry-<ET date>`. */
  id: string;
  entryOrderId?: string;
  underlying: string;
  kind: "bull_put_spread" | "bear_call_spread";
  openedAt: string;
  entryEtDate: string;
  shortSymbol: string;
  longSymbol: string;
  shortStrike: number;
  longStrike: number;
  width: number;
  contracts: number;
  /** Per spread, per share — the credit we asked for at entry (limit). */
  credit: number;
  /** Per spread, per share — actual fill when Alpaca reports it; drives P&L exits. */
  filledCredit?: number;
  /** Underlying spot when the spread was opened — for chart context and manage prompts. */
  entrySpot?: number;
  /** Per spread, per share — `width - effectiveCredit`. */
  maxLossPerSpread: number;
  expiration: string;
  /** `targetProfitPct * credit` — mechanical profit exit. */
  targetBuyback: number;
  /** `stopMultiple * credit` — mechanical stop exit. */
  stopBuyback: number;
  status: ManagedSpreadStatus;
  closedAt?: string;
  closeReason?: string;
  closeOrderId?: string;
  lastLlm?: ManagedSpreadLlmNote;
}

/** A free-text note the agent keeps for later cycles (fed back into the prompt). */
/** Credit baseline for P&L and mechanical exits — fill when known, else the entry limit. */
export function spreadEntryCredit(spread: ManagedSpread): number {
  return spread.filledCredit ?? spread.credit;
}

export interface AgentNote {
  at: string;
  etDate: string;
  topic: string;
  text: string;
}

export interface AgentState {
  version: 1;
  /** ET dates the agent has already opened a position on — one entry per day. */
  enteredEtDates: string[];
  /** ISO timestamp of an entry currently being submitted (soft lock, ~90s). */
  entryInFlightAt?: string;
  /** Open positions + a tail of recently closed ones. */
  spreads: ManagedSpread[];
  /** A tail of the most recent notes. */
  notes: AgentNote[];
}

// --- Cycle report (`POST /api/agent/run`) --------------------------------

export type EntryReport =
  | { evaluated: false; reason: string }
  | {
      evaluated: true;
      acted: boolean;
      skipped?: string;
      error?: string;
      orderId?: string;
      decisionId?: string;
      llm?: DecisionRecord["llm"];
    };

export interface ManagedReport {
  id: string;
  shortSymbol: string;
  zone: SpreadZone;
  action: "hold" | "closed" | "close-failed" | "closing";
  buyback: number | null;
  pnlPctOfCredit: number | null;
  distanceToShortPct: number | null;
  llm?: { action: string; reason: string };
  decisionId?: string;
  orderId?: string;
  error?: string;
}

export interface AgentCycleReport {
  at: string;
  phase: CompetitionPhase;
  entryWindowOpen: boolean;
  account: { ok: boolean; number?: string; equity: number; violations: string[] };
  entry: EntryReport;
  managed: ManagedReport[];
  errors: string[];
}

// --- Status (`GET /api/agent/status`) ----------------------------------

export interface AgentStatus {
  enabled: boolean;
  llm: { model: string; baseUrl: string };
  config: AgentConfig;
  competition: CompetitionStatus;
  account: {
    ok: boolean;
    number?: string;
    equity: number;
    optionsLevel?: number;
    violations: string[];
    warnings: string[];
  };
  /** AI-readable dump of the working-memory file. */
  state: string;
  enteredToday: boolean;
  spreads: ManagedSpread[];
  /** Present when `?withMarks=true`. */
  marks?: SpreadMarkSummary[];
}

export interface SpreadMarkSummary {
  id: string;
  spot: number | null;
  buyback: number | null;
  openPnlPerSpread: number | null;
  pnlPctOfCredit: number | null;
  distanceToShortPct: number | null;
  minutesToExpiry: number;
  minutesToSnapshot: number;
  priceable: boolean;
  zone: SpreadZone;
}
