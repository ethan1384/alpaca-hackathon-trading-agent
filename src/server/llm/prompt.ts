import "server-only";

/**
 * Static system prompts (kept first in the message list so provider prompt
 * caching can reuse the prefix) and the compact user-prompt builders.
 *
 * The prompts spell out the one thing the model must not do: touch the
 * mechanical exits. It approves or vetoes an entry, and in the dead zone it
 * decides hold vs close early — nothing else.
 */

export const ENTRY_SYSTEM_PROMPT = `You are the risk officer on a SPY put-credit-spread desk during a 4-day paper-trading competition.

A mechanical system has ALREADY chosen the strikes, the width, and the position size. You cannot change any of that. Your only decision is: let this ONE entry through, or skip it for today.

Veto (act=false) when:
- a scheduled macro event lands before this spread expires: CPI, PPI, FOMC decision or minutes, NFP / jobs report, a major Fed speaker, a large earnings day that moves the index;
- SPY's recent trend is rolling over toward the short strike (lower highs / lower lows, a break of a visible support);
- the option is not paying for the risk: the short leg's implied vol sits at or below SPY's recent realised vol (IV/RV at or under 1.0), so the credit does not cover the tail — the loss that matters here is a gap straight through the short strike.

Approve (act=true) only when none of those are elevated and the credit looks fair for the distance to the short strike.

When in doubt, veto — a skipped day costs nothing, a gap through the short strike costs the max loss.

Respond with ONLY a JSON object: {"act": boolean, "confidence": number 0-1, "reason": string, "concerns": string[]}`;

export const MANAGE_SYSTEM_PROMPT = `You manage ONE open SPY put credit spread during a 4-day paper-trading competition.

The mechanical system already handles the profit target (buy back at 50% of the credit), the stop (buy back at 3x the credit), the time-close on expiry day, and the forced close before the final equity snapshot. DO NOT second-guess any of those — they are not your call.

You are consulted ONLY in the "dead zone": the position is at a loss AND either the underlying is drifting toward the short strike or little time remains. Your decision:
- "close": take the small loss now, because the move toward the short strike looks real and riding to the 3x stop (or through an overnight/gap) risks the full max loss;
- "hold": the drift looks like noise, there is enough time and distance, the credit is still defensible.

Respond with ONLY a JSON object: {"action": "hold" | "close", "reason": string, "urgency": "low" | "medium" | "high"}`;

/** Annualised vol as a percentage, or the literal `unknown` the prompts use. */
function formatPct(v: number | null): string {
  return v == null ? "unknown" : `${(v * 100).toFixed(1)}%`;
}

/** IV/RV, or `unknown` when either side is missing or realised vol is zero. */
function formatRatio(iv: number | null, rv: number | null): string {
  if (iv == null || rv == null || rv <= 0) {
    return "unknown";
  }
  return (iv / rv).toFixed(2);
}

export interface EntryPromptContext {
  todayEt: string;
  phase: string;
  hoursUntilSnapshot: number;
  optionDeadline: string;
  spot: number;
  realisedVol: number | null;
  /** Implied vol of the short leg. Null when the feed omits it. */
  shortIv: number | null;
  /** Daily closes, oldest first. Empty when the history call failed. */
  recentCloses: number[];
  shortStrike: number;
  longStrike: number;
  width: number;
  dte: number;
  expiration: string;
  midCredit: number;
  entryLimit: number;
  creditRatio: number;
  shortDelta: number | null;
  contracts: number;
  maxLossUsd: number;
  pctOfEquity: number;
  recentDecisions: string;
  notes: string;
}

export function buildEntryUserPrompt(c: EntryPromptContext): string {
  return [
    `Date (ET): ${c.todayEt}. Competition phase: ${c.phase}. Hours until the equity snapshot: ${c.hoursUntilSnapshot.toFixed(1)}. Option expiration deadline: ${c.optionDeadline}.`,
    ``,
    `SPY spot: ${c.spot.toFixed(2)}. 20-day realised vol (annualised): ${formatPct(c.realisedVol)}.`,
    `Short-leg implied vol: ${formatPct(c.shortIv)}. IV/RV: ${formatRatio(c.shortIv, c.realisedVol)} (above 1.0 = the option pays more than SPY's recent movement justifies).`,
    `Recent daily closes (oldest first; the last value may be today's session still in progress): ${
      c.recentCloses.length > 0 ? c.recentCloses.map((x) => x.toFixed(2)).join(", ") : "unavailable"
    }`,
    ``,
    `Proposed put credit spread:`,
    `  sell ${c.shortStrike} put / buy ${c.longStrike} put, width ${c.width}, expiration ${c.expiration} (${c.dte} DTE).`,
    `  mid credit ${c.midCredit.toFixed(2)}, entry limit ${c.entryLimit.toFixed(2)}, credit/width ${(c.creditRatio * 100).toFixed(0)}%, short |delta| ${c.shortDelta == null ? "unknown" : c.shortDelta.toFixed(2)}.`,
    `  size ${c.contracts} contract(s), max loss $${c.maxLossUsd.toFixed(0)} (${(c.pctOfEquity * 100).toFixed(2)}% of equity).`,
    ``,
    `Recent agent decisions:`,
    c.recentDecisions || "  (none)",
    c.notes ? `\nNotes carried from earlier:\n${c.notes}` : "",
    ``,
    `Reason about whether any scheduled macro event lands on or before ${c.expiration}. Then decide.`,
  ].join("\n");
}

export interface ManagePromptContext {
  todayEt: string;
  spot: number;
  shortStrike: number;
  distanceToShortPct: number;
  minutesToExpiry: number;
  minutesToSnapshot: number;
  credit: number;
  buyback: number;
  openPnlUsd: number;
  pnlPctOfCredit: number;
  targetBuyback: number;
  stopBuyback: number;
  openedAt: string;
  priorNote: string;
}

export function buildManageUserPrompt(c: ManagePromptContext): string {
  return [
    `Date (ET): ${c.todayEt}.`,
    `SPY spot: ${c.spot.toFixed(2)}. Short strike: ${c.shortStrike}. Distance spot->short strike: ${(c.distanceToShortPct * 100).toFixed(2)}% (positive = still out of the money).`,
    `Minutes to expiry: ${c.minutesToExpiry.toFixed(0)}. Minutes to the equity snapshot: ${c.minutesToSnapshot.toFixed(0)}.`,
    ``,
    `Credit collected: ${c.credit.toFixed(2)}. Current buyback cost: ${c.buyback.toFixed(2)}.`,
    `Open P&L: $${c.openPnlUsd.toFixed(0)} (${(c.pnlPctOfCredit * 100).toFixed(0)}% of the credit; negative = losing).`,
    `Mechanical profit target buyback: ${c.targetBuyback.toFixed(2)}. Mechanical stop buyback: ${c.stopBuyback.toFixed(2)}.`,
    `Opened at: ${c.openedAt}.`,
    c.priorNote ? `\nYour earlier note on this spread: ${c.priorNote}` : "",
    ``,
    `Decide: close early for the small loss, or hold.`,
  ].join("\n");
}
