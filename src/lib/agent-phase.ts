import { AGENT, etMinutes, etMinutesOf } from "@/config/agent";
import type { AgentStatus } from "@/domain/agent";

/**
 * Pure derivation of "what is the agent doing right now" from the read-only
 * status payload (`GET /api/agent/status?withMarks=true`) plus whether a cycle
 * is currently in flight.
 *
 * The agent has no long-lived process: `runAgentCycle()` is a request that
 * starts and ends. The cockpit's live state is therefore *reconstructed* from
 * the very inputs the next cycle will branch on — competition phase, the ET
 * entry window, whether today's entry is spent, and the zone each open spread
 * marks into (`src/server/agent/run-cycle.ts`). Keep this module pure so that
 * mapping stays unit-testable and the browser never pulls a server module.
 */

export const AGENT_PIPELINE_STEPS = [
  { id: "market", label: "Market feed", hint: "SPY 1-min bars via the Alpaca hub" },
  { id: "trigger", label: "Trigger", hint: "ET entry window + per-spread exit checks" },
  { id: "setup", label: "Setup", hint: "strikes, width, credit, short delta" },
  { id: "llm", label: "LLM decision", hint: "entry veto / dead-zone early close" },
  { id: "order", label: "Guardrails + order", hint: "risk gate then Alpaca mleg" },
] as const;

export type AgentPipelineStepId = (typeof AGENT_PIPELINE_STEPS)[number]["id"];

export type AgentPhaseId =
  | "booting"
  | "offline"
  | "standby"
  | "armed"
  | "scanning"
  | "thinking"
  | "monitoring"
  | "alert"
  | "closing"
  | "done";

/** Drives the dot colour and the pulse in the cockpit header. */
export type AgentTone = "idle" | "wait" | "active" | "warn" | "danger" | "ok";

export interface AgentPhaseView {
  id: AgentPhaseId;
  label: string;
  detail: string;
  tone: AgentTone;
  /** Index into `AGENT_PIPELINE_STEPS` — the step lit up as "currently here". */
  step: number;
  /** `true` while something is actively being computed (drives the animation). */
  live: boolean;
  /** Minutes until the next thing the agent is waiting for; `null` when nothing is pending. */
  nextEventInMinutes: number | null;
  nextEventLabel: string | null;
}

export interface AgentPhaseInput {
  status?: AgentStatus;
  /** A `POST /api/agent/run` is in flight. */
  running: boolean;
  now?: Date;
}

/** Zones the code exits on without ever asking the model. */
const MECHANICAL_ZONES = new Set(["deadline", "stop", "profit_target", "time_close"]);

function view(v: AgentPhaseView): AgentPhaseView {
  return v;
}

export function deriveAgentPhase({
  status,
  running,
  now = new Date(),
}: AgentPhaseInput): AgentPhaseView {
  if (!status) {
    return view({
      id: "booting",
      label: "Connecting",
      detail: "Reading agent status…",
      tone: "idle",
      step: 0,
      live: false,
      nextEventInMinutes: null,
      nextEventLabel: null,
    });
  }

  if (!status.enabled) {
    return view({
      id: "offline",
      label: "Agent disabled",
      detail: "AGENT_ENABLED=false — the cycle refuses to open anything.",
      tone: "idle",
      step: 0,
      live: false,
      nextEventInMinutes: null,
      nextEventLabel: null,
    });
  }

  const marks = status.marks ?? [];
  const openSpreads = status.spreads;
  const etNow = etMinutesOf(now);
  const windowStart = etMinutes(AGENT.entryWindowEt.start);
  const windowEnd = etMinutes(AGENT.entryWindowEt.end);
  const scoring = status.competition.phase === "scoring";

  if (running) {
    return view({
      id: "thinking",
      label: "Deliberating",
      detail: "Cycle in flight: mark open spreads → build candidate → put it to the model.",
      tone: "active",
      step: 3,
      live: true,
      nextEventInMinutes: null,
      nextEventLabel: null,
    });
  }

  const closingSpread = openSpreads.find((s) => s.status === "closing");
  const mechanicalMark = marks.find((m) => MECHANICAL_ZONES.has(m.zone));
  if (closingSpread || mechanicalMark) {
    const zone = mechanicalMark?.zone ?? closingSpread?.closeReason ?? "close";
    return view({
      id: "closing",
      label: "Closing",
      detail: `Mechanical exit fired (${zone}) — the model is not consulted on this one.`,
      tone: "danger",
      step: 4,
      live: true,
      nextEventInMinutes: null,
      nextEventLabel: null,
    });
  }

  const deadZone = marks.find((m) => m.zone === "dead_zone");
  if (deadZone) {
    return view({
      id: "alert",
      label: "Dead zone",
      detail: "Losing and near the short strike — the next cycle asks the model to hold or close.",
      tone: "warn",
      step: 3,
      live: true,
      nextEventInMinutes: Math.round(deadZone.minutesToExpiry),
      nextEventLabel: "to expiry",
    });
  }

  if (openSpreads.length > 0) {
    const mark = marks[0];
    return view({
      id: "monitoring",
      label: "Monitoring",
      detail:
        mark && mark.pnlPctOfCredit != null
          ? `${openSpreads.length} spread open, comfortable — ${(mark.pnlPctOfCredit * 100).toFixed(0)}% of credit captured.`
          : `${openSpreads.length} spread open, comfortable — polling marks each cycle.`,
      tone: "ok",
      step: 1,
      live: true,
      nextEventInMinutes: mark ? Math.round(mark.minutesToExpiry) : null,
      nextEventLabel: mark ? "to expiry" : null,
    });
  }

  if (!scoring) {
    return view({
      id: "standby",
      label: "Standby",
      detail: `Competition phase "${status.competition.phase}" — opening new risk is refused outside the scoring window.`,
      tone: "idle",
      step: 0,
      live: false,
      nextEventInMinutes: null,
      nextEventLabel: null,
    });
  }

  if (status.enteredToday) {
    return view({
      id: "done",
      label: "Entry spent",
      detail: "One entry per ET session — the agent is flat and waits for tomorrow's window.",
      tone: "idle",
      step: 1,
      live: false,
      nextEventInMinutes: null,
      nextEventLabel: null,
    });
  }

  if (etNow < windowStart) {
    return view({
      id: "armed",
      label: "Armed — waiting for trigger",
      detail: `Entry window opens at ${AGENT.entryWindowEt.start} ET, once the opening volatility has settled.`,
      tone: "wait",
      step: 1,
      live: true,
      nextEventInMinutes: windowStart - etNow,
      nextEventLabel: "to the entry window",
    });
  }

  if (etNow <= windowEnd) {
    return view({
      id: "scanning",
      label: "Scanning for setup",
      detail: `Inside the ${AGENT.entryWindowEt.start}–${AGENT.entryWindowEt.end} ET window: pricing ${AGENT.targetDelta} delta short puts, ${AGENT.spreadWidth}-wide.`,
      tone: "active",
      step: 2,
      live: true,
      nextEventInMinutes: windowEnd - etNow,
      nextEventLabel: "until the window shuts",
    });
  }

  return view({
    id: "standby",
    label: "Window closed",
    detail: `Today's ${AGENT.entryWindowEt.start}–${AGENT.entryWindowEt.end} ET window passed with no fill — flat until tomorrow.`,
    tone: "idle",
    step: 1,
    live: false,
    nextEventInMinutes: null,
    nextEventLabel: null,
  });
}

/** `137` → `"2h 17m"`. */
export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) {
    return `${total}m`;
  }
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, "0")}m`;
}
