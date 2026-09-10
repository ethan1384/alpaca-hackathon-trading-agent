/**
 * Legacy machine-readable event calendar. The personal-project status and migration
 * direction live in `docs/05-legacy-competition.md`.
 *
 * Pure module — no env, no `server-only`, no I/O — so both the server guardrails
 * and any UI surface can import it, and so every rule is unit-testable.
 */

/** Days in milliseconds. */
const DAY_MS = 86_400_000;

/**
 * Official milestones. Times are US/Eastern in the source document; September
 * 2026 is EDT (UTC−4), so the UTC instants below are the ET times minus 4h.
 */
export const COMPETITION = {
  /** [R1] Required starting balance of the official paper account, in USD. */
  startingEquity: 100_000,
  /** Hackathon window opens — Fri 2026-08-28 09:30 ET. */
  hackathonStart: "2026-08-28T13:30:00.000Z",
  /** [R4] Official scoring starts — Mon 2026-08-31 09:30 ET. */
  scoringStart: "2026-08-31T13:30:00.000Z",
  /** [R5] Judged equity is read here — Thu 2026-09-03 16:00 ET (EOD). */
  equitySnapshot: "2026-09-03T20:00:00.000Z",
  /** [R6] Window closes — Fri 2026-09-04 09:30 ET. */
  scoringEnd: "2026-09-04T13:30:00.000Z",
  /**
   * [D4] Last option expiration that settles inside the measured window.
   * Exercises/assignments on this date are reflected in the judged equity.
   */
  optionExpirationDeadline: "2026-09-03",
  /**
   * [D11] Ceiling on capital at risk in open option premium, as a fraction of
   * equity. Terminal equity is the score, but a blown-up account scores zero.
   */
  maxPortfolioRiskPct: 0.25,
} as const;

/**
 * Where `now` sits relative to the official milestones.
 *
 * - `pre` — before scoring opens; testing account territory, nothing counts.
 * - `scoring` — the only phase in which opening a new position is meaningful.
 * - `snapshot-passed` — judged equity is already fixed; later P&L is not scored.
 * - `closed` — the window is over.
 */
export type CompetitionPhase = "pre" | "scoring" | "snapshot-passed" | "closed";

function ms(iso: string): number {
  return Date.parse(iso);
}

export function getCompetitionPhase(now: Date = new Date()): CompetitionPhase {
  const t = now.getTime();
  if (t < ms(COMPETITION.scoringStart)) {
    return "pre";
  }
  if (t < ms(COMPETITION.equitySnapshot)) {
    return "scoring";
  }
  if (t < ms(COMPETITION.scoringEnd)) {
    return "snapshot-passed";
  }
  return "closed";
}

/**
 * [D3][D5] Opening new risk only makes sense while the scored window is running.
 * Closing is always allowed — risk must always be reducible.
 */
export function isOpeningWindowOpen(now: Date = new Date()): boolean {
  return getCompetitionPhase(now) === "scoring";
}

/** Milliseconds until the judged equity snapshot; 0 once it has passed. */
export function msUntilSnapshot(now: Date = new Date()): number {
  return Math.max(0, ms(COMPETITION.equitySnapshot) - now.getTime());
}

const ET_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The `YYYY-MM-DD` an instant falls on in US/Eastern — the exchange's calendar. */
export function easternDate(now: Date = new Date()): string {
  const parts = ET_DATE_FORMAT.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "01";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Whole days between two `YYYY-MM-DD` dates. The single definition of what a
 * "day" means anywhere DTE is counted — the backtests included, so a window they
 * test is the window production resolves.
 */
export function daysBetweenDates(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/**
 * Whole days from `now` to an `YYYY-MM-DD` expiration, both read on the US/Eastern
 * calendar. Shared with `select-contract` so the DTE window and the deadline clamp
 * agree.
 *
 * Measured date-to-date, not instant-to-midnight. The difference is a full day and
 * it used to bite: comparing `now` against midnight *UTC* of the expiry put the
 * reference 20:00 ET the evening before, so during a session today's expiry scored
 * −1 and tomorrow's scored 0. A 0DTE strategy asking for `minDte: 0` therefore
 * matched tomorrow's contract and never the one it meant.
 */
export function daysToExpiration(expiration: string, now: Date = new Date()): number {
  return daysBetweenDates(easternDate(now), expiration);
}

/** [D4] Does this expiration settle on or before the judged snapshot? */
export function isExpirationWithinWindow(expiration: string): boolean {
  return expiration <= COMPETITION.optionExpirationDeadline;
}

/**
 * [D4] Largest DTE an *opening* trade may target: the deadline expiration.
 * Negative once the deadline has passed — callers read that as "no new risk".
 */
export function maxDteForOpening(now: Date = new Date()): number {
  return daysToExpiration(COMPETITION.optionExpirationDeadline, now);
}

/**
 * [D4] Narrow a strategy's requested DTE window so contract selection cannot
 * reach past the deadline. Returns `null` when the window collapses (nothing
 * expiring in range settles inside the measured window) — treat as "no trade".
 */
export function clampDteWindow(
  minDte: number,
  maxDte: number,
  now: Date = new Date(),
): { minDte: number; maxDte: number } | null {
  const ceiling = maxDteForOpening(now);
  if (ceiling < 0) {
    return null;
  }
  const clampedMax = Math.min(maxDte, ceiling);
  const clampedMin = Math.min(minDte, clampedMax);
  return clampedMin > clampedMax ? null : { minDte: clampedMin, maxDte: clampedMax };
}

/** Snapshot of the competition state, for logs and the MCP status tool. */
export interface CompetitionStatus {
  phase: CompetitionPhase;
  now: string;
  scoringStart: string;
  equitySnapshot: string;
  scoringEnd: string;
  optionExpirationDeadline: string;
  hoursUntilSnapshot: number;
  openingWindowOpen: boolean;
  maxDteForOpening: number;
}

export function getCompetitionStatus(now: Date = new Date()): CompetitionStatus {
  return {
    phase: getCompetitionPhase(now),
    now: now.toISOString(),
    scoringStart: COMPETITION.scoringStart,
    equitySnapshot: COMPETITION.equitySnapshot,
    scoringEnd: COMPETITION.scoringEnd,
    optionExpirationDeadline: COMPETITION.optionExpirationDeadline,
    hoursUntilSnapshot: Math.round((msUntilSnapshot(now) / 3_600_000) * 10) / 10,
    openingWindowOpen: isOpeningWindowOpen(now),
    maxDteForOpening: maxDteForOpening(now),
  };
}
