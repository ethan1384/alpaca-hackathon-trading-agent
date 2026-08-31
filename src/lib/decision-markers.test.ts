import { describe, expect, it } from "vitest";
import type { DecisionRecord } from "@/domain/decision";
import type { Bar } from "@/domain/types";
import { classifyDecision, decisionMarkers } from "./decision-markers";

function bar(timestamp: string): Bar {
  return {
    symbol: "SPY",
    assetClass: "stock",
    open: 500,
    high: 501,
    low: 499,
    close: 500.5,
    volume: 1_000,
    timestamp,
  };
}

const BARS = [
  bar("2026-09-01T14:00:00.000Z"),
  bar("2026-09-01T14:01:00.000Z"),
  bar("2026-09-01T14:02:00.000Z"),
];

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "d1",
    at: "2026-09-01T14:01:30.000Z",
    strategy: "agent:credit-spread",
    underlying: "SPY",
    trigger: { kind: "entry" },
    chosen: null,
    rejected: [],
    guardrails: {},
    sizing: null,
    outcome: { status: "no-trade" },
    ...overrides,
  };
}

describe("classifyDecision", () => {
  it("maps a submitted entry to an entry marker", () => {
    expect(classifyDecision(decision({ outcome: { status: "submitted" } }))).toBe("entry");
  });

  it("maps a submitted manage to a close marker", () => {
    const d = decision({ trigger: { kind: "manage" }, outcome: { status: "submitted" } });
    expect(classifyDecision(d)).toBe("close");
  });

  it("separates an LLM veto from a mechanical no-setup", () => {
    expect(classifyDecision(decision({ llm: { model: "m" } }))).toBe("veto");
    expect(classifyDecision(decision())).toBe("skip");
  });

  it("treats a dead-zone hold as a hold", () => {
    expect(
      classifyDecision(decision({ trigger: { kind: "manage", detail: "dead_zone/hold" } })),
    ).toBe("hold");
  });

  it("flags guardrail blocks and errors alike", () => {
    expect(classifyDecision(decision({ outcome: { status: "blocked" } }))).toBe("blocked");
    expect(classifyDecision(decision({ outcome: { status: "error", error: "boom" } }))).toBe(
      "blocked",
    );
  });
});

describe("decisionMarkers", () => {
  it("snaps a mid-candle decision back to the candle it happened in", () => {
    const [marker] = decisionMarkers([decision()], BARS);
    expect(marker.time).toBe("2026-09-01T14:01:00.000Z");
  });

  it("drops decisions that predate the chart window", () => {
    expect(decisionMarkers([decision({ at: "2026-09-01T13:00:00.000Z" })], BARS)).toEqual([]);
  });

  it("clamps a decision newer than the last bar onto the last bar", () => {
    const [marker] = decisionMarkers([decision({ at: "2026-09-01T14:09:00.000Z" })], BARS);
    expect(marker.time).toBe("2026-09-01T14:02:00.000Z");
  });

  it("returns nothing without bars to anchor to", () => {
    expect(decisionMarkers([decision()], [])).toEqual([]);
  });

  it("labels an execution with its contract count", () => {
    const [marker] = decisionMarkers(
      [
        decision({
          outcome: { status: "submitted" },
          chosen: { kind: "bull_put_spread", legs: ["a", "b"], contracts: 3, reason: "ok" },
        }),
      ],
      BARS,
    );
    expect(marker.text).toBe("ENTRY ×3");
    expect(marker.shape).toBe("arrowUp");
  });
});
