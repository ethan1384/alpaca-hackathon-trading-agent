import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/config/env";
import { StrategySignalSchema } from "@/domain/strategy";
import {
  applyCompetitionDteWindow,
  assertSignalAllowed,
  checkSignal,
  isOpeningSignal,
} from "./guardrails";

const ORIGINAL_ENV = { ...process.env };

/** Mid-window: Tue 2026-09-01, inside the scored session. */
const DURING = new Date("2026-09-01T15:00:00Z");
/** Before Monday's 09:30 ET open — nothing traded here is scored. */
const BEFORE = new Date("2026-08-29T15:00:00Z");

function signal(overrides: Record<string, unknown> = {}) {
  return StrategySignalSchema.parse({
    strategy: "test",
    underlying: "SPY",
    bias: "bullish",
    kind: "long_call",
    selection: { minDte: 7, maxDte: 45 },
    confidence: 0.7,
    reason: "test",
    timestamp: DURING.toISOString(),
    ...overrides,
  });
}

const leg = (symbol: string, positionIntent = "buy_to_open") => ({
  symbol,
  side: "buy" as const,
  ratioQty: 1,
  positionIntent,
});

/** Expires Wed 2026-09-02 — settles before the judged snapshot. */
const IN_WINDOW = "SPY260902C00500000";
/** Expires Fri 2026-09-18 — its outcome falls outside the measured window. */
const PAST_DEADLINE = "SPY260918C00500000";

function enforce(on: boolean) {
  process.env.ALPACA_API_KEY = "key";
  process.env.ALPACA_API_SECRET = "secret";
  process.env.COMPETITION_ENFORCE = on ? "true" : "false";
  resetEnvCache();
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
  resetEnvCache();
});

describe("isOpeningSignal", () => {
  it("treats an unresolved signal as opening", () => {
    expect(isOpeningSignal(signal())).toBe(true);
  });

  it("exempts a pure closing signal", () => {
    const closing = signal({
      resolvedLegs: [leg(PAST_DEADLINE, "sell_to_close")],
    });
    expect(isOpeningSignal(closing)).toBe(false);
  });
});

describe("checkSignal", () => {
  beforeEach(() => enforce(true));

  it("passes an in-window opening trade", () => {
    const verdict = checkSignal(signal({ resolvedLegs: [leg(IN_WINDOW)] }), DURING);
    expect(verdict.violations).toEqual([]);
    expect(verdict.allowed).toBe(true);
    expect(verdict.phase).toBe("scoring");
  });

  it("blocks an opening trade before scoring starts", () => {
    const verdict = checkSignal(signal({ resolvedLegs: [leg(IN_WINDOW)] }), BEFORE);
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations.join(" ")).toMatch(/only scored during the competition window/);
  });

  it("blocks a leg expiring past the judged snapshot", () => {
    const verdict = checkSignal(signal({ resolvedLegs: [leg(PAST_DEADLINE)] }), DURING);
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations.join(" ")).toMatch(/past the judged snapshot/);
  });

  it("never blocks a closing trade, whatever the phase or expiry", () => {
    const closing = signal({ resolvedLegs: [leg(PAST_DEADLINE, "sell_to_close")] });
    expect(checkSignal(closing, BEFORE).allowed).toBe(true);
    expect(checkSignal(closing, DURING).violations).toEqual([]);
  });

  it("warns when the requested DTE window has to be clamped", () => {
    const verdict = checkSignal(signal(), DURING);
    expect(verdict.violations).toEqual([]);
    expect(verdict.warnings.join(" ")).toMatch(/clamped to/);
  });

  it("reports no expiration is left once the deadline has passed", () => {
    const verdict = checkSignal(signal(), new Date("2026-09-04T13:30:00Z"));
    expect(verdict.violations.join(" ")).toMatch(/no expiration on or before/);
  });

  it("downgrades violations to warnings when enforcement is off", () => {
    enforce(false);
    const verdict = checkSignal(signal({ resolvedLegs: [leg(PAST_DEADLINE)] }), DURING);
    expect(verdict.allowed).toBe(true);
    expect(verdict.violations.length).toBeGreaterThan(0);
    expect(verdict.warnings.join(" ")).toMatch(/COMPETITION_ENFORCE is off/);
  });
});

describe("assertSignalAllowed", () => {
  it("throws on a violation when enforcing", () => {
    enforce(true);
    expect(() =>
      assertSignalAllowed(signal({ resolvedLegs: [leg(PAST_DEADLINE)] }), DURING),
    ).toThrow(/Hackathon guardrail/);
  });

  it("lets the same signal through when enforcement is off", () => {
    enforce(false);
    expect(() =>
      assertSignalAllowed(signal({ resolvedLegs: [leg(PAST_DEADLINE)] }), DURING),
    ).not.toThrow();
  });
});

describe("applyCompetitionDteWindow", () => {
  it("clamps the window to the deadline when enforcing", () => {
    enforce(true);
    const narrowed = applyCompetitionDteWindow(signal(), DURING);
    // Tue 2026-09-01 11:00 ET -> Thu 2026-09-03 is two days on the exchange calendar.
    expect(narrowed.selection.maxDte).toBe(2);
    expect(narrowed.selection.minDte).toBe(2);
  });

  it("leaves the strategy's own window alone outside the official run", () => {
    enforce(false);
    expect(applyCompetitionDteWindow(signal(), DURING).selection).toEqual({
      minDte: 7,
      maxDte: 45,
      minOpenInterest: 0,
      maxSpreadPct: 0.25,
    });
  });
});
