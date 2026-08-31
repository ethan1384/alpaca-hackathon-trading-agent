import { describe, expect, it } from "vitest";
import {
  COMPETITION,
  clampDteWindow,
  daysToExpiration,
  easternDate,
  getCompetitionPhase,
  getCompetitionStatus,
  isExpirationWithinWindow,
  isOpeningWindowOpen,
  maxDteForOpening,
  msUntilSnapshot,
} from "./competition";

const at = (iso: string) => new Date(iso);

describe("getCompetitionPhase", () => {
  it("is pre before scoring opens", () => {
    expect(getCompetitionPhase(at("2026-08-29T12:00:00Z"))).toBe("pre");
    // One millisecond before the Monday 09:30 ET open.
    expect(getCompetitionPhase(at("2026-08-31T13:29:59.999Z"))).toBe("pre");
  });

  it("is scoring from Monday 09:30 ET to Thursday EOD", () => {
    expect(getCompetitionPhase(at(COMPETITION.scoringStart))).toBe("scoring");
    expect(getCompetitionPhase(at("2026-09-03T19:59:59Z"))).toBe("scoring");
  });

  it("is snapshot-passed between the Thursday snapshot and Friday close", () => {
    expect(getCompetitionPhase(at(COMPETITION.equitySnapshot))).toBe("snapshot-passed");
    expect(getCompetitionPhase(at("2026-09-04T13:29:00Z"))).toBe("snapshot-passed");
  });

  it("is closed after Friday 09:30 ET", () => {
    expect(getCompetitionPhase(at(COMPETITION.scoringEnd))).toBe("closed");
  });
});

describe("isOpeningWindowOpen", () => {
  it("only opens during the scored window", () => {
    expect(isOpeningWindowOpen(at("2026-08-30T12:00:00Z"))).toBe(false);
    expect(isOpeningWindowOpen(at("2026-09-01T15:00:00Z"))).toBe(true);
    // The judged equity is already fixed — new risk cannot improve the score.
    expect(isOpeningWindowOpen(at("2026-09-03T21:00:00Z"))).toBe(false);
  });
});

describe("msUntilSnapshot", () => {
  it("counts down to the Thursday close and floors at zero", () => {
    expect(msUntilSnapshot(at("2026-09-03T19:00:00Z"))).toBe(3_600_000);
    expect(msUntilSnapshot(at("2026-09-04T12:00:00Z"))).toBe(0);
  });
});

describe("daysToExpiration", () => {
  it("counts whole days on the US/Eastern calendar", () => {
    // Mon 09:30 ET. Today is 0, and Thursday's deadline expiry is 3 — the plain
    // market reading, and the one a strategy's `minDte`/`maxDte` assumes.
    const monOpen = at("2026-08-31T13:30:00Z");
    expect(daysToExpiration("2026-08-31", monOpen)).toBe(0);
    expect(daysToExpiration("2026-09-01", monOpen)).toBe(1);
    expect(daysToExpiration("2026-09-03", monOpen)).toBe(3);
  });

  it("stays on the session's date through the whole trading day", () => {
    // 20:00Z is 16:00 ET — still Monday in New York, so nothing has rolled over.
    expect(daysToExpiration("2026-09-03", at("2026-08-31T20:00:00Z"))).toBe(3);
  });

  it("reads an instant by its Eastern date, not its UTC one", () => {
    // 2026-08-31T00:00Z is Sunday 20:00 in New York: four days to Thursday, not
    // three. Measuring against the UTC date would silently lose one.
    expect(daysToExpiration("2026-09-03", at("2026-08-31T00:00:00Z"))).toBe(4);
    expect(easternDate(at("2026-08-31T00:00:00Z"))).toBe("2026-08-30");
  });

  it("goes negative once the expiration is behind us", () => {
    expect(daysToExpiration("2026-09-03", at("2026-09-04T13:30:00Z"))).toBe(-1);
  });
});

describe("isExpirationWithinWindow", () => {
  it("accepts expirations that settle inside the measured window", () => {
    expect(isExpirationWithinWindow("2026-09-02")).toBe(true);
    expect(isExpirationWithinWindow(COMPETITION.optionExpirationDeadline)).toBe(true);
  });

  it("rejects expirations past the judged snapshot", () => {
    expect(isExpirationWithinWindow("2026-09-04")).toBe(false);
    expect(isExpirationWithinWindow("2026-09-18")).toBe(false);
  });
});

describe("clampDteWindow", () => {
  it("caps a long DTE window at the deadline", () => {
    // DTE is measured on the Eastern calendar, exactly as `pickExpiration` does,
    // so Mon 09:30 ET -> Thu 2026-09-03 is 3.
    expect(clampDteWindow(7, 45, at("2026-08-31T13:30:00Z"))).toEqual({ minDte: 3, maxDte: 3 });
  });

  it("leaves a window that already fits untouched", () => {
    expect(clampDteWindow(0, 2, at("2026-08-31T13:30:00Z"))).toEqual({ minDte: 0, maxDte: 2 });
  });

  it("returns null once the deadline has passed", () => {
    expect(clampDteWindow(0, 7, at("2026-09-04T13:30:00Z"))).toBeNull();
  });
});

describe("getCompetitionStatus", () => {
  it("reports the phase and the remaining runway", () => {
    const status = getCompetitionStatus(at("2026-09-01T14:00:00Z"));
    expect(status.phase).toBe("scoring");
    expect(status.openingWindowOpen).toBe(true);
    expect(status.maxDteForOpening).toBe(maxDteForOpening(at("2026-09-01T14:00:00Z")));
    expect(status.hoursUntilSnapshot).toBeGreaterThan(0);
  });
});
