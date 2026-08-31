import { describe, expect, it } from "vitest";
import { AGENT } from "@/config/agent";
import type { AgentStatus, ManagedSpread, SpreadMarkSummary } from "@/domain/agent";
import { AGENT_PIPELINE_STEPS, deriveAgentPhase, formatMinutes } from "./agent-phase";

/** 2026-09-01 is a Tuesday inside the scoring window; ET is UTC-4 in September. */
function etDate(hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(2026, 8, 1, h + 4, m));
}

function spread(overrides: Partial<ManagedSpread> = {}): ManagedSpread {
  return {
    id: "agent-entry-2026-09-01",
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
    credit: 0.6,
    maxLossPerSpread: 4.4,
    expiration: "2026-09-02",
    targetBuyback: 0.3,
    stopBuyback: 1.8,
    status: "open",
    ...overrides,
  };
}

function mark(overrides: Partial<SpreadMarkSummary> = {}): SpreadMarkSummary {
  return {
    id: "agent-entry-2026-09-01",
    spot: 505,
    buyback: 0.3,
    openPnlPerSpread: 0.3,
    pnlPctOfCredit: 0.5,
    distanceToShortPct: 0.01,
    minutesToExpiry: 400,
    minutesToSnapshot: 500,
    priceable: true,
    zone: "comfortable",
    ...overrides,
  };
}

function status(overrides: Partial<AgentStatus> = {}): AgentStatus {
  return {
    enabled: true,
    llm: { model: "test-model", baseUrl: "http://localhost" },
    config: AGENT,
    competition: {
      phase: "scoring",
      now: "2026-09-01T14:00:00Z",
      scoringStart: "2026-08-31T13:30:00Z",
      equitySnapshot: "2026-09-03T20:00:00Z",
      scoringEnd: "2026-09-04T20:00:00Z",
      optionExpirationDeadline: "2026-09-03",
      hoursUntilSnapshot: 54,
      openingWindowOpen: true,
      maxDteForOpening: 2,
    },
    account: { ok: true, number: "PA123", equity: 100_000, violations: [], warnings: [] },
    state: "{}",
    enteredToday: false,
    spreads: [],
    ...overrides,
  };
}

describe("deriveAgentPhase", () => {
  it("reports booting before the first status lands", () => {
    expect(deriveAgentPhase({ running: false }).id).toBe("booting");
  });

  it("reports offline when the agent is disabled", () => {
    const phase = deriveAgentPhase({ status: status({ enabled: false }), running: false });
    expect(phase.id).toBe("offline");
    expect(phase.live).toBe(false);
  });

  it("is armed with a countdown before the daily entry window", () => {
    const phase = deriveAgentPhase({ status: status(), running: false, now: etDate("09:30") });
    expect(phase.id).toBe("armed");
    expect(phase.nextEventInMinutes).toBe(30);
  });

  it("scans inside the entry window", () => {
    const phase = deriveAgentPhase({ status: status(), running: false, now: etDate("10:15") });
    expect(phase.id).toBe("scanning");
    expect(phase.nextEventInMinutes).toBe(45);
  });

  it("goes to standby once the window shuts with nothing filled", () => {
    const phase = deriveAgentPhase({ status: status(), running: false, now: etDate("13:00") });
    expect(phase.id).toBe("standby");
  });

  it("marks the day's entry spent", () => {
    const phase = deriveAgentPhase({
      status: status({ enteredToday: true }),
      running: false,
      now: etDate("13:00"),
    });
    expect(phase.id).toBe("done");
  });

  it("stands by outside the scoring window even during the entry hour", () => {
    const base = status();
    const phase = deriveAgentPhase({
      status: status({ competition: { ...base.competition, phase: "pre" } }),
      running: false,
      now: etDate("10:15"),
    });
    expect(phase.id).toBe("standby");
  });

  it("shows deliberation while a cycle is in flight", () => {
    const phase = deriveAgentPhase({ status: status(), running: true, now: etDate("10:15") });
    expect(phase.id).toBe("thinking");
    expect(phase.live).toBe(true);
  });

  it("monitors a comfortable open spread", () => {
    const phase = deriveAgentPhase({
      status: status({ spreads: [spread()], marks: [mark()] }),
      running: false,
      now: etDate("13:00"),
    });
    expect(phase.id).toBe("monitoring");
    expect(phase.nextEventInMinutes).toBe(400);
  });

  it("raises the dead zone — the only place the manage LLM is consulted", () => {
    const phase = deriveAgentPhase({
      status: status({ spreads: [spread()], marks: [mark({ zone: "dead_zone" })] }),
      running: false,
      now: etDate("13:00"),
    });
    expect(phase.id).toBe("alert");
    expect(phase.step).toBe(3);
  });

  it("prefers a mechanical exit over the dead zone", () => {
    const phase = deriveAgentPhase({
      status: status({
        spreads: [spread(), spread({ id: "b" })],
        marks: [mark({ zone: "dead_zone" }), mark({ id: "b", zone: "stop" })],
      }),
      running: false,
      now: etDate("13:00"),
    });
    expect(phase.id).toBe("closing");
  });

  it("treats a spread already being closed as closing", () => {
    const phase = deriveAgentPhase({
      status: status({ spreads: [spread({ status: "closing" })] }),
      running: false,
      now: etDate("13:00"),
    });
    expect(phase.id).toBe("closing");
  });

  it("keeps every step index addressable", () => {
    const cases = [
      deriveAgentPhase({ running: false }),
      deriveAgentPhase({ status: status(), running: true }),
      deriveAgentPhase({ status: status(), running: false, now: etDate("10:15") }),
    ];
    for (const phase of cases) {
      expect(AGENT_PIPELINE_STEPS[phase.step]).toBeDefined();
    }
  });
});

describe("formatMinutes", () => {
  it("stays in minutes under an hour", () => {
    expect(formatMinutes(45)).toBe("45m");
  });

  it("splits hours and pads the minutes", () => {
    expect(formatMinutes(137)).toBe("2h 17m");
  });

  it("floors negatives at zero", () => {
    expect(formatMinutes(-5)).toBe("0m");
  });
});
