import "server-only";

import {
  COMPETITION,
  type CompetitionPhase,
  clampDteWindow,
  getCompetitionPhase,
  isExpirationWithinWindow,
} from "@/config/competition";
import { getEnv } from "@/config/env";
import type { OptionOrderLeg, StrategySignal } from "@/domain/strategy";
import { parseOptionSymbol } from "@/domain/types";

/**
 * Legacy event guardrails applied to every signal before it becomes a real order.
 * Their current compatibility status lives in `docs/05-legacy-competition.md`; the dates and DTE
 * maths live in `src/config/competition.ts`. This module only decides what to do
 * about a breach.
 *
 * Closing trades are never blocked — risk must always be reducible, whatever the
 * phase.
 */

export interface GuardrailVerdict {
  /** False only when a hard rule is broken *and* enforcement is on. */
  allowed: boolean;
  phase: CompetitionPhase;
  /** Hard-rule breaches. Throw-worthy under `COMPETITION_ENFORCE=true`. */
  violations: string[];
  /** Advisory notes — never block. */
  warnings: string[];
}

/**
 * `COMPETITION_ENFORCE` decides whether a violation throws or merely warns.
 *
 * Read defensively: a guardrail must never be the reason a call fails for an
 * unrelated reason (a unit test with no Alpaca credentials, say). When the env
 * cannot be parsed at all, fall back to warn-only.
 */
export function isCompetitionEnforced(): boolean {
  try {
    return getEnv().COMPETITION_ENFORCE;
  } catch {
    return false;
  }
}

/** A leg that opens exposure, as opposed to closing an existing position. */
function isOpeningLeg(leg: OptionOrderLeg): boolean {
  return leg.positionIntent === "buy_to_open" || leg.positionIntent === "sell_to_open";
}

/** Does this signal add exposure? Pure closing/adjusting signals are exempt. */
export function isOpeningSignal(signal: StrategySignal): boolean {
  const legs = signal.resolvedLegs;
  // No resolved legs yet -> selection still has to be resolved, which only
  // happens for an entry.
  return legs === undefined || legs.length === 0 || legs.some(isOpeningLeg);
}

/**
 * Evaluate a signal against the competition rules. Pure — no env, no I/O — so
 * callers can surface the verdict (MCP, UI, logs) without side effects.
 */
export function checkSignal(signal: StrategySignal, now: Date = new Date()): GuardrailVerdict {
  const phase = getCompetitionPhase(now);
  const violations: string[] = [];
  const warnings: string[] = [];

  if (!isOpeningSignal(signal)) {
    return { allowed: true, phase, violations, warnings };
  }

  // [D5] Opening risk outside the scored window cannot improve the result.
  if (phase !== "scoring") {
    const detail: Record<CompetitionPhase, string> = {
      pre: `official scoring opens ${COMPETITION.scoringStart}`,
      scoring: "",
      "snapshot-passed": `judged equity was fixed at ${COMPETITION.equitySnapshot}`,
      closed: `the window closed ${COMPETITION.scoringEnd}`,
    };
    violations.push(
      `opening trades are only scored during the competition window (phase "${phase}": ${detail[phase]})`,
    );
  }

  // [D4] Legs must settle on or before the judged snapshot.
  for (const leg of signal.resolvedLegs ?? []) {
    if (!isOpeningLeg(leg)) {
      continue;
    }
    const contract = parseOptionSymbol(leg.symbol);
    if (!contract) {
      violations.push(`leg ${leg.symbol} is not a valid OCC option symbol`);
      continue;
    }
    if (!isExpirationWithinWindow(contract.expiration)) {
      violations.push(
        `leg ${leg.symbol} expires ${contract.expiration}, past the judged snapshot (${COMPETITION.optionExpirationDeadline}) — its outcome is never realised inside the measured window`,
      );
    }
  }

  // Unresolved signal: check the requested DTE window can still produce a
  // contract that settles in time.
  if (!signal.resolvedLegs?.length) {
    const clamped = clampDteWindow(signal.selection.minDte, signal.selection.maxDte, now);
    if (!clamped) {
      violations.push(
        `no expiration on or before ${COMPETITION.optionExpirationDeadline} is still available`,
      );
    } else if (clamped.maxDte !== signal.selection.maxDte) {
      warnings.push(
        `DTE window ${signal.selection.minDte}-${signal.selection.maxDte} clamped to ${clamped.minDte}-${clamped.maxDte} to settle before the judged snapshot`,
      );
    }
  }

  const enforced = isCompetitionEnforced();
  if (violations.length > 0 && !enforced) {
    warnings.push(
      `COMPETITION_ENFORCE is off — ${violations.length} rule breach(es) allowed through: ${violations.join("; ")}`,
    );
  }

  return { allowed: violations.length === 0 || !enforced, phase, violations, warnings };
}

/**
 * Throw if `signal` breaks a hard rule and enforcement is on; otherwise log the
 * warnings and let it through. Called by `executeSignal` — the single execution
 * entry point — so no code path can place a competition-illegal order silently.
 */
export function assertSignalAllowed(signal: StrategySignal, now: Date = new Date()): void {
  const verdict = checkSignal(signal, now);
  for (const warning of verdict.warnings) {
    console.warn(`[guardrails] ${warning}`);
  }
  if (!verdict.allowed) {
    throw new Error(`Hackathon guardrail: ${verdict.violations.join("; ")}`);
  }
}

/**
 * [D4] Narrow a signal's DTE window so contract selection cannot reach past the
 * judged snapshot. Only applied under `COMPETITION_ENFORCE` — outside the
 * official run the strategy's own window is left alone, so development and
 * backtests are not silently rewritten.
 *
 * Returns the signal unchanged when no narrowing is needed (or possible —
 * `checkSignal` has already reported that case as a violation).
 */
export function applyCompetitionDteWindow(
  signal: StrategySignal,
  now: Date = new Date(),
): StrategySignal {
  if (!isCompetitionEnforced()) {
    return signal;
  }
  const clamped = clampDteWindow(signal.selection.minDte, signal.selection.maxDte, now);
  if (!clamped || clamped.maxDte === signal.selection.maxDte) {
    return signal;
  }
  return { ...signal, selection: { ...signal.selection, ...clamped } };
}
