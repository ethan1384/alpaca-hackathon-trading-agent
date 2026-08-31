import { describe, expect, it } from "vitest";
import { AGENT, etMinutes, etMinutesOf } from "./agent";

describe("AGENT config invariants", () => {
  it("keeps the stop wider than the credit and the target inside it", () => {
    expect(AGENT.stopMultiple).toBeGreaterThan(1);
    expect(AGENT.targetProfitPct).toBeGreaterThan(0);
    expect(AGENT.targetProfitPct).toBeLessThan(1);
  });

  it("has a coherent DTE window", () => {
    expect(AGENT.minDte).toBeLessThanOrEqual(AGENT.maxDte);
    expect(AGENT.minDte).toBeGreaterThanOrEqual(0);
  });

  it("has positive dead-zone thresholds", () => {
    expect(AGENT.deadZoneProximityPct).toBeGreaterThan(0);
    expect(AGENT.deadZoneMinutes).toBeGreaterThan(0);
  });

  it("keeps the credit ratio ceiling below the width", () => {
    expect(AGENT.maxCreditRatio).toBeGreaterThan(0);
    expect(AGENT.maxCreditRatio).toBeLessThan(1);
  });

  it("keeps the credit ratio floor below the ceiling and above zero", () => {
    expect(AGENT.minCreditRatio).toBeGreaterThan(0);
    expect(AGENT.minCreditRatio).toBeLessThan(AGENT.maxCreditRatio);
  });

  it("sizes at most a small fraction of equity per spread", () => {
    expect(AGENT.riskPerSidePct).toBeGreaterThan(0);
    expect(AGENT.riskPerSidePct).toBeLessThanOrEqual(0.05);
    expect(AGENT.maxConcurrentSpreads).toBeGreaterThanOrEqual(1);
  });
});

describe("etMinutes", () => {
  it("converts HH:MM to minutes since midnight", () => {
    expect(etMinutes("00:00")).toBe(0);
    expect(etMinutes("10:00")).toBe(600);
    expect(etMinutes("15:30")).toBe(930);
    expect(etMinutes("23:59")).toBe(1439);
  });

  it("rejects malformed strings", () => {
    expect(() => etMinutes("10:0")).toThrow();
    expect(() => etMinutes("25:00")).toThrow();
    expect(() => etMinutes("10:61")).toThrow();
    expect(() => etMinutes("nope")).toThrow();
  });
});

describe("etMinutesOf", () => {
  it("reads the America/New_York wall clock", () => {
    // 2026-06-15 14:30:00Z is 10:30 EDT.
    expect(etMinutesOf(new Date("2026-06-15T14:30:00Z"))).toBe(10 * 60 + 30);
    // 2026-01-15 14:30:00Z is 09:30 EST.
    expect(etMinutesOf(new Date("2026-01-15T14:30:00Z"))).toBe(9 * 60 + 30);
  });
});
