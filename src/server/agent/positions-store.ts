import "server-only";

import type { AgentNote, AgentState, ManagedSpread } from "@/domain/agent";
import { readAgentStateText, writeAgentStateText } from "./persistence";

/**
 * The agent's mutable working memory: one JSON document at
 * `agent/agent-state.json` (blob) or `${AGENT_LOG_DIR}/agent-state.json`
 * (filesystem). Kept separate from the append-only `decisions.jsonl` audit trail.
 *
 * Pure in-memory state is unsafe (a cron-triggered process can start cold);
 * `globalThis` is used only as a hot-reload cache. Writes are serialized through
 * a module-scope promise chain so an overlapping cron + UI-timer pair cannot
 * corrupt the file. A missing or unparseable file yields a fresh empty state and
 * a warning — never a throw, same discipline as `recordDecision`.
 */

const MAX_CLOSED_SPREADS = 30;
const MAX_NOTES = 50;

function emptyState(): AgentState {
  return { version: 1, enteredEtDates: [], spreads: [], notes: [] };
}

interface StoreGlobal {
  cache?: AgentState;
  queue: Promise<unknown>;
}

const globalRef = globalThis as { __agentStore?: StoreGlobal };
if (!globalRef.__agentStore) {
  globalRef.__agentStore = { queue: Promise.resolve() };
}
const store: StoreGlobal = globalRef.__agentStore;

function normalize(raw: unknown): AgentState {
  if (!raw || typeof raw !== "object") {
    return emptyState();
  }
  const s = raw as Partial<AgentState>;
  return {
    version: 1,
    enteredEtDates: Array.isArray(s.enteredEtDates)
      ? s.enteredEtDates.filter((x) => typeof x === "string")
      : [],
    entryInFlightAt: typeof s.entryInFlightAt === "string" ? s.entryInFlightAt : undefined,
    spreads: Array.isArray(s.spreads) ? (s.spreads as ManagedSpread[]) : [],
    notes: Array.isArray(s.notes) ? (s.notes as AgentNote[]) : [],
  };
}

export async function loadAgentState(): Promise<AgentState> {
  if (store.cache) {
    return store.cache;
  }
  try {
    const contents = await readAgentStateText();
    if (contents == null) {
      store.cache = emptyState();
      return store.cache;
    }
    store.cache = normalize(JSON.parse(contents));
  } catch (error) {
    console.warn("[agent-state] could not read state, starting fresh:", error);
    store.cache = emptyState();
  }
  return store.cache;
}

async function persist(next: AgentState): Promise<void> {
  // Trim history before it hits disk.
  const closed = next.spreads.filter((s) => s.status === "closed");
  const open = next.spreads.filter((s) => s.status !== "closed");
  const trimmed: AgentState = {
    ...next,
    spreads: [...open, ...closed.slice(-MAX_CLOSED_SPREADS)],
    notes: next.notes.slice(-MAX_NOTES),
  };
  store.cache = trimmed;
  await writeAgentStateText(`${JSON.stringify(trimmed, null, 2)}\n`);
}

export async function saveAgentState(next: AgentState): Promise<void> {
  store.queue = store.queue.then(() =>
    persist(next).catch((e) => console.warn("[agent-state] write failed:", e)),
  );
  await store.queue;
}

/** Read-modify-write, serialized against every other mutation. */
export async function mutateAgentState(
  fn: (state: AgentState) => AgentState | Promise<AgentState>,
): Promise<AgentState> {
  const run = store.queue.then(async () => {
    const current = store.cache ?? (await loadAgentState());
    const next = normalize(await fn(structuredClone(current)));
    await persist(next).catch((e) => console.warn("[agent-state] write failed:", e));
    return store.cache ?? next;
  });
  store.queue = run.catch(() => undefined);
  return run;
}

/** Compact, AI-readable dump for `/api/agent/status` and the UI. */
export function serializeAgentState(s: AgentState): string {
  const lines: string[] = [
    `entered ET dates: ${s.enteredEtDates.join(", ") || "(none)"}`,
    s.entryInFlightAt ? `entry in flight since ${s.entryInFlightAt}` : "no entry in flight",
    `spreads (${s.spreads.length}):`,
  ];
  for (const sp of s.spreads) {
    lines.push(
      `  ${sp.id} ${sp.status} ${sp.kind} ${sp.shortStrike}/${sp.longStrike} x${sp.contracts} ` +
        `credit ${sp.credit.toFixed(2)} exp ${sp.expiration}` +
        (sp.closeReason ? ` — closed (${sp.closeReason})` : "") +
        (sp.lastLlm ? ` — last LLM: ${sp.lastLlm.action} (${sp.lastLlm.reason})` : ""),
    );
  }
  if (s.notes.length > 0) {
    lines.push("notes:");
    for (const n of s.notes.slice(-10)) {
      lines.push(`  [${n.etDate}] ${n.topic}: ${n.text}`);
    }
  }
  return lines.join("\n");
}

/** Test hook. */
export function __resetAgentStateForTests(): void {
  store.cache = undefined;
  store.queue = Promise.resolve();
}
