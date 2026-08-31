import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/config/env";
import type { AgentState, ManagedSpread } from "@/domain/agent";
import { __resetAgentPersistenceForTests } from "./persistence";
import {
  __resetAgentStateForTests,
  loadAgentState,
  mutateAgentState,
  serializeAgentState,
} from "./positions-store";

let dir: string;
const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "agent-state-"));
  process.env.ALPACA_API_KEY = "k";
  process.env.ALPACA_API_SECRET = "s";
  process.env.AGENT_LOG_DIR = dir;
  resetEnvCache();
  __resetAgentPersistenceForTests();
  __resetAgentStateForTests();
});

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  resetEnvCache();
  __resetAgentPersistenceForTests();
  __resetAgentStateForTests();
  await rm(dir, { recursive: true, force: true });
});

function spread(id: string, over: Partial<ManagedSpread> = {}): ManagedSpread {
  return {
    id,
    underlying: "SPY",
    kind: "bull_put_spread",
    openedAt: "2026-09-01T14:05:00Z",
    entryEtDate: "2026-09-01",
    shortSymbol: "SPY260902P00500000",
    longSymbol: "SPY260902P00495000",
    shortStrike: 500,
    longStrike: 495,
    width: 5,
    contracts: 2,
    credit: 0.83,
    maxLossPerSpread: 4.17,
    expiration: "2026-09-02",
    targetBuyback: 0.415,
    stopBuyback: 2.49,
    status: "open",
    ...over,
  };
}

describe("agent state store", () => {
  it("starts empty and round-trips a mutation", async () => {
    expect((await loadAgentState()).spreads).toEqual([]);

    await mutateAgentState((s) => ({
      ...s,
      enteredEtDates: ["2026-09-01"],
      spreads: [spread("agent-entry-2026-09-01")],
    }));

    __resetAgentStateForTests();
    const reloaded = await loadAgentState();
    expect(reloaded.enteredEtDates).toEqual(["2026-09-01"]);
    expect(reloaded.spreads).toHaveLength(1);
  });

  it("returns a fresh state when the file is corrupt", async () => {
    await writeFile(path.join(dir, "agent-state.json"), "{ not json", "utf8");
    const state = await loadAgentState();
    expect(state).toEqual({ version: 1, enteredEtDates: [], spreads: [], notes: [] });
  });

  it("serializes overlapping mutations without losing writes", async () => {
    await Promise.all([
      mutateAgentState((s) => ({ ...s, enteredEtDates: [...s.enteredEtDates, "a"] })),
      mutateAgentState((s) => ({ ...s, enteredEtDates: [...s.enteredEtDates, "b"] })),
      mutateAgentState((s) => ({ ...s, enteredEtDates: [...s.enteredEtDates, "c"] })),
    ]);
    const state = await loadAgentState();
    expect([...state.enteredEtDates].sort()).toEqual(["a", "b", "c"]);
  });

  it("caps the closed-spread history", async () => {
    await mutateAgentState((s) => ({
      ...s,
      spreads: Array.from({ length: 40 }, (_, i) =>
        spread(`c${i}`, { status: "closed", closeReason: "target" }),
      ),
    }));
    const state = await loadAgentState();
    expect(state.spreads.length).toBe(30);
  });

  it("serializeAgentState is human-readable", () => {
    const state: AgentState = {
      version: 1,
      enteredEtDates: ["2026-09-01"],
      spreads: [spread("agent-entry-2026-09-01")],
      notes: [
        {
          at: "2026-09-01T14:00:00Z",
          etDate: "2026-09-01",
          topic: "cpi",
          text: "CPI is 09-11, clear",
        },
      ],
    };
    const text = serializeAgentState(state);
    expect(text).toContain("agent-entry-2026-09-01 open bull_put_spread 500/495");
    expect(text).toContain("cpi: CPI is 09-11, clear");
  });
});
