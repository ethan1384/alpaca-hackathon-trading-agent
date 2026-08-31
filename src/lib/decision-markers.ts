import type { ChartMarker } from "@/components/dashboard/PriceChart";
import type { DecisionRecord } from "@/domain/decision";
import type { Bar } from "@/domain/types";

/**
 * Projects the [O5] decision log onto the underlying's tape, so the chart shows
 * *where* the agent acted, not just that it did. Pure — the cockpit memoizes
 * the result and hands it to `PriceChart`.
 */

export type DecisionMarkerKind = "entry" | "close" | "veto" | "hold" | "blocked" | "skip";

interface MarkerStyle {
  position: ChartMarker["position"];
  shape: ChartMarker["shape"];
  color: string;
  label: string;
  /** Human-readable line for the chart legend. */
  legend: string;
}

export const DECISION_MARKER_STYLES: Record<DecisionMarkerKind, MarkerStyle> = {
  entry: {
    position: "belowBar",
    shape: "arrowUp",
    color: "#10b981",
    label: "ENTRY",
    legend: "credit spread opened",
  },
  close: {
    position: "aboveBar",
    shape: "arrowDown",
    color: "#38bdf8",
    label: "CLOSE",
    legend: "spread bought back",
  },
  veto: {
    position: "aboveBar",
    shape: "circle",
    color: "#f59e0b",
    label: "LLM VETO",
    legend: "model refused the candidate",
  },
  hold: {
    position: "aboveBar",
    shape: "circle",
    color: "#a78bfa",
    label: "HOLD",
    legend: "dead-zone check — model said hold",
  },
  blocked: {
    position: "aboveBar",
    shape: "square",
    color: "#ef4444",
    label: "BLOCKED",
    legend: "guardrail or execution error",
  },
  skip: {
    position: "aboveBar",
    shape: "circle",
    color: "#64748b",
    label: "NO SETUP",
    legend: "mechanical filters found nothing",
  },
};

/** Which of the six shapes a record earns. Mirrors `runAgentCycle()`'s branches. */
export function classifyDecision(decision: DecisionRecord): DecisionMarkerKind {
  const { status } = decision.outcome;
  if (status === "blocked" || status === "error") {
    return "blocked";
  }
  if (status === "submitted") {
    return decision.trigger.kind === "entry" ? "entry" : "close";
  }
  if (decision.trigger.kind === "manage") {
    return "hold";
  }
  return decision.llm ? "veto" : "skip";
}

/**
 * Snap an instant back to the last bar that opened at or before it. Markers
 * need an existing bar to anchor to; a decision taken mid-candle belongs to the
 * candle it happened in. Returns `null` when the decision predates the window.
 */
function snapToBar(at: string, barTimes: number[]): string | null {
  const t = Date.parse(at);
  if (Number.isNaN(t)) {
    return null;
  }
  let chosen: number | null = null;
  for (const barTime of barTimes) {
    if (barTime > t) {
      break;
    }
    chosen = barTime;
  }
  return chosen == null ? null : new Date(chosen).toISOString();
}

export function decisionMarkers(decisions: DecisionRecord[], bars: Bar[]): ChartMarker[] {
  if (bars.length === 0) {
    return [];
  }
  const barTimes = bars.map((bar) => Date.parse(bar.timestamp));

  return decisions.flatMap((decision): ChartMarker[] => {
    const time = snapToBar(decision.at, barTimes);
    if (!time) {
      return [];
    }
    const kind = classifyDecision(decision);
    const style = DECISION_MARKER_STYLES[kind];
    const contracts = decision.chosen?.contracts;
    return [
      {
        time,
        position: style.position,
        shape: style.shape,
        color: style.color,
        text:
          contracts && (kind === "entry" || kind === "close")
            ? `${style.label} ×${contracts}`
            : style.label,
        size: kind === "skip" || kind === "hold" ? 0.8 : 1.2,
      },
    ];
  });
}
