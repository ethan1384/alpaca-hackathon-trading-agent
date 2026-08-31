import "server-only";

import { appendDecisionLine, readDecisionsText } from "@/server/agent/persistence";
import type {
  DecisionDraft,
  DecisionOutcome,
  DecisionRecord,
  RejectedAlternative,
} from "@/domain/decision";
import type { PlaceOrderInput } from "@/domain/trading";
import { parseOptionSymbol } from "@/domain/types";

export type { DecisionDraft, DecisionOutcome, DecisionRecord, RejectedAlternative };

/**
 * [O5] Structured decision log.
 *
 * The requirement is not a trade blotter. A blotter records what was done; a
 * decision log records **why**, and in particular records the alternatives that
 * were considered and dropped. That is the field a judge reads to tell a
 * reasoning agent from a random one, and the field a post-mortem needs when a
 * trade went wrong for a reason that was visible at the time.
 *
 * Two sinks, deliberately:
 * - an append-only JSONL file, so the record survives the process and can be
 *   handed to a reviewer (or another model) as-is;
 * - an in-memory ring, so the UI and MCP can show recent decisions without
 *   re-reading the file.
 *
 * Writing is best-effort: a failed log write must never abort a trade, and must
 * never mask the trading error that was being logged.
 */

const RING_SIZE = 200;
const ring: DecisionRecord[] = [];

function nextId(at: string): string {
  return `${at.replace(/[-:.TZ]/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Record one decision. Returns the completed record so the caller can reference
 * its id. Never throws — see the module note.
 */
export async function recordDecision(draft: DecisionDraft): Promise<DecisionRecord> {
  const at = draft.at ?? new Date().toISOString();
  const record: DecisionRecord = { ...draft, at, id: draft.id ?? nextId(at) };

  ring.push(record);
  if (ring.length > RING_SIZE) {
    ring.splice(0, ring.length - RING_SIZE);
  }

  try {
    await appendDecisionLine(JSON.stringify(record));
  } catch (error) {
    console.warn(`[decision-log] could not persist ${record.id}:`, error);
  }

  return record;
}

/**
 * A compact [O5] record for an action taken outside the strategy/agent layer —
 * a raw `place_order`, a `close_position`, an order cancel/replace. These bypass
 * `executeSignal` (and therefore its trace), so they are logged here directly so
 * "every order the system placed, and why" stays answerable from one file.
 */
export async function recordManualAction(params: {
  /** e.g. "place_order", "close_position", "cancel_order". */
  action: string;
  underlying?: string;
  legs?: string[];
  contracts?: number;
  reason?: string;
  outcome: DecisionRecord["outcome"];
  source?: string;
}): Promise<DecisionRecord> {
  return recordDecision({
    strategy: params.source ? `manual:${params.source}` : "manual",
    underlying: params.underlying ?? "—",
    trigger: { kind: "manual", detail: params.action },
    chosen: params.legs?.length
      ? {
          kind: params.action,
          legs: params.legs,
          contracts: params.contracts ?? 0,
          reason: params.reason ?? params.action,
        }
      : null,
    rejected: [],
    guardrails: {},
    sizing: null,
    outcome: params.outcome,
  });
}

/** Pull `{ underlying, legs, contracts }` out of a raw order for the manual log. */
export function describeOrder(input: PlaceOrderInput): {
  underlying?: string;
  legs: string[];
  contracts?: number;
} {
  const legs = input.legs?.length
    ? input.legs.map((l) => l.symbol)
    : input.symbol
      ? [input.symbol]
      : [];
  const underlying = legs
    .map((s) => parseOptionSymbol(s)?.underlying ?? s)
    .find((u): u is string => Boolean(u));
  return { underlying, legs, contracts: input.qty };
}

/** Most recent decisions, newest last. For the UI and the MCP status tool. */
export function recentDecisions(limit = 50): DecisionRecord[] {
  return ring.slice(-limit);
}

/** Test/reset hook. */
export function clearDecisionRing(): void {
  ring.length = 0;
}

/**
 * The in-memory ring is empty after a cold start (a cron-triggered process that
 * has not itself recorded anything yet). This reads the tail of the JSONL sink
 * so `/api/agent/decisions` still has something to show. Never throws.
 */
export async function readRecentDecisionsFromDisk(limit = 50): Promise<DecisionRecord[]> {
  try {
    const contents = await readDecisionsText();
    const lines = contents.split("\n").filter((l) => l.trim().length > 0);
    const records: DecisionRecord[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        records.push(JSON.parse(line) as DecisionRecord);
      } catch {
        // skip a partial/corrupt trailing line
      }
    }
    return records;
  } catch {
    return [];
  }
}

/**
 * The same history in the compact form a reviewing model reads well: one line
 * per decision, outcome first, rejected alternatives kept — they are the part
 * worth reviewing.
 */
export function serializeForReview(records: DecisionRecord[] = recentDecisions()): string {
  return records
    .map((r) => {
      const head = `${r.at} ${r.outcome.status.toUpperCase()} ${r.strategy}/${r.underlying}`;
      const chosen = r.chosen
        ? `chose ${r.chosen.kind} [${r.chosen.legs.join(" ")}] x${r.chosen.contracts} — ${r.chosen.reason}`
        : "no trade";
      const dropped = r.rejected.length
        ? ` | rejected: ${r.rejected.map((a) => `${a.what} (${a.why})`).join("; ")}`
        : "";
      const blocked = Object.entries(r.guardrails)
        .flatMap(([name, v]) => (v?.violations ?? []).map((x) => `${name}:${x}`))
        .join("; ");
      return `${head} | ${chosen}${dropped}${blocked ? ` | blocked by ${blocked}` : ""}`;
    })
    .join("\n");
}
