import "server-only";

import type { TradingPosition } from "@/domain/trading";
import { listPositions as defaultListPositions } from "@/server/alpaca/trading";

/**
 * [O6] State reconciliation.
 *
 * At the start of every cycle, check that what the agent believes it holds is
 * what the account actually holds. The two drift for ordinary reasons — a fill
 * the agent never saw, an assignment, a partial close, a restart that lost
 * in-memory state — and every one of them makes the sizing logic wrong in a way
 * no risk cap can catch, because the caps are computed from the wrong book.
 *
 * The account is always the source of truth. This module reports the drift; it
 * does not silently adopt either side, because "the agent forgot a position" and
 * "a position was assigned overnight" need different responses.
 */

export interface PositionDrift {
  symbol: string;
  /** Contracts the agent believes it holds. 0 = unknown to the agent. */
  expectedQty: number;
  /** Contracts the account actually reports. 0 = gone. */
  actualQty: number;
}

export interface ReconciliationReport {
  at: string;
  inSync: boolean;
  /** Held by the account, unknown to the agent — an unmanaged position. */
  untracked: PositionDrift[];
  /** Known to the agent, absent from the account — closed or assigned behind us. */
  missing: PositionDrift[];
  /** Known to both, different size. */
  mismatched: PositionDrift[];
  /** Positions that agree. */
  matchedCount: number;
}

/** Signed contract count: Alpaca reports `qty` unsigned with a `side`. */
function signedQty(position: TradingPosition): number {
  return position.side === "short" ? -Math.abs(position.qty) : Math.abs(position.qty);
}

/**
 * Compare the agent's expected book against the account's real one.
 *
 * `expected` maps symbol -> signed contract count. Pass the agent's own view;
 * an empty map on a fresh start correctly reports every open position as
 * untracked, which is the honest reading — nothing is being managed yet.
 */
export async function reconcilePositions(
  expected: Map<string, number> | Record<string, number>,
  deps: { listPositions?: () => Promise<TradingPosition[]> } = {},
): Promise<ReconciliationReport> {
  const listPositions = deps.listPositions ?? defaultListPositions;
  const want = expected instanceof Map ? expected : new Map(Object.entries(expected));

  const actual = new Map<string, number>();
  for (const position of await listPositions()) {
    actual.set(position.symbol, signedQty(position));
  }

  const untracked: PositionDrift[] = [];
  const missing: PositionDrift[] = [];
  const mismatched: PositionDrift[] = [];
  let matchedCount = 0;

  for (const [symbol, actualQty] of actual) {
    const expectedQty = want.get(symbol) ?? 0;
    if (expectedQty === 0) {
      untracked.push({ symbol, expectedQty: 0, actualQty });
    } else if (expectedQty !== actualQty) {
      mismatched.push({ symbol, expectedQty, actualQty });
    } else {
      matchedCount += 1;
    }
  }

  for (const [symbol, expectedQty] of want) {
    if (expectedQty !== 0 && !actual.has(symbol)) {
      missing.push({ symbol, expectedQty, actualQty: 0 });
    }
  }

  const report: ReconciliationReport = {
    at: new Date().toISOString(),
    inSync: untracked.length === 0 && missing.length === 0 && mismatched.length === 0,
    untracked,
    missing,
    mismatched,
    matchedCount,
  };

  if (!report.inSync) {
    console.warn(
      `[reconcile] drift: ${untracked.length} untracked, ${missing.length} missing, ${mismatched.length} mismatched`,
    );
  }
  return report;
}
