import "server-only";

import { RISK, readDrawdown } from "@/config/risk";
import type { TradingAccount } from "@/domain/trading";
import {
  cancelAllOrders as defaultCancelAllOrders,
  closeAllPositions as defaultCloseAllPositions,
  getTradingAccount as defaultGetTradingAccount,
} from "@/server/alpaca/trading";

/**
 * [O1] Kill switch.
 *
 * One rule: if intraday drawdown against the session's opening equity exceeds
 * `RISK.killSwitchDrawdownPct`, flatten everything and stop opening positions
 * until a human re-arms it.
 *
 * Two design choices worth stating, because both are the point of the control:
 *
 * 1. **Tripping halts the agent, not just the trade.** A drawdown that large
 *    means the agent's read of the market is wrong; letting it keep sizing into
 *    the same read is how a bad day becomes a zero. [R14] scores terminal
 *    equity, and a blown-up account scores zero on both axes ([D11]).
 * 2. **Re-arming is manual.** An automatic reset would make this a speed bump
 *    rather than a switch.
 *
 * State lives on `globalThis` for the same reason the hub does: Next dev-mode
 * HMR re-evaluates modules, and a kill switch that forgets it tripped is not a
 * kill switch.
 */

export interface KillSwitchState {
  /** True once the drawdown threshold was breached. Blocks every opening trade. */
  tripped: boolean;
  trippedAt?: string;
  reason?: string;
  /** What the liquidation actually managed to do, for the post-mortem. */
  liquidation?: {
    ordersCancelled: number;
    positionsClosed: number;
    error?: string;
  };
  /** Last drawdown reading, whether or not it tripped. */
  lastReading?: {
    at: string;
    equity: number;
    sessionOpenEquity: number;
    drawdownPct: number;
  };
}

declare global {
  // eslint-disable-next-line no-var
  var __killSwitch: KillSwitchState | undefined;
}

function state(): KillSwitchState {
  if (!globalThis.__killSwitch) {
    globalThis.__killSwitch = { tripped: false };
  }
  return globalThis.__killSwitch;
}

export function getKillSwitchState(): Readonly<KillSwitchState> {
  return { ...state() };
}

/** True while the agent is halted. Every opening path must consult this. */
export function isHalted(): boolean {
  return state().tripped;
}

export interface KillSwitchDeps {
  getTradingAccount: () => Promise<TradingAccount>;
  cancelAllOrders: typeof defaultCancelAllOrders;
  closeAllPositions: typeof defaultCloseAllPositions;
}

const defaultDeps: KillSwitchDeps = {
  getTradingAccount: defaultGetTradingAccount,
  cancelAllOrders: defaultCancelAllOrders,
  closeAllPositions: defaultCloseAllPositions,
};

/**
 * Read the account, update the drawdown reading, and trip + liquidate if the
 * threshold is breached. Safe to call every cycle; liquidation runs once.
 */
export async function evaluateKillSwitch(
  deps: Partial<KillSwitchDeps> = {},
): Promise<Readonly<KillSwitchState>> {
  const { getTradingAccount, cancelAllOrders, closeAllPositions } = { ...defaultDeps, ...deps };
  const s = state();

  const account = await getTradingAccount();
  const reading = readDrawdown(account);
  s.lastReading = {
    at: new Date().toISOString(),
    equity: reading.equity,
    sessionOpenEquity: reading.sessionOpenEquity,
    drawdownPct: reading.drawdownPct,
  };

  if (s.tripped || !reading.tripped) {
    return getKillSwitchState();
  }

  s.tripped = true;
  s.trippedAt = new Date().toISOString();
  s.reason = `[O1] intraday drawdown ${(reading.drawdownPct * 100).toFixed(2)}% exceeds the ${(RISK.killSwitchDrawdownPct * 100).toFixed(0)}% limit (equity ${reading.equity.toFixed(0)} vs session open ${reading.sessionOpenEquity.toFixed(0)})`;
  console.error(`[kill-switch] TRIPPED — ${s.reason}`);

  // Cancel first: an open order can refill a position we are about to close.
  try {
    const cancelled = await cancelAllOrders();
    const closed = await closeAllPositions(true);
    s.liquidation = { ordersCancelled: cancelled.length, positionsClosed: closed.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    s.liquidation = { ordersCancelled: 0, positionsClosed: 0, error: message };
    console.error(`[kill-switch] liquidation failed — ${message}. Manual intervention required.`);
  }

  return getKillSwitchState();
}

/**
 * Trip the switch without a drawdown reading — the manual "stop everything"
 * path, and the one the drill exercises.
 */
export async function tripKillSwitch(
  reason: string,
  deps: Partial<KillSwitchDeps> = {},
): Promise<Readonly<KillSwitchState>> {
  const s = state();
  if (s.tripped) {
    return getKillSwitchState();
  }
  const { cancelAllOrders, closeAllPositions } = { ...defaultDeps, ...deps };
  s.tripped = true;
  s.trippedAt = new Date().toISOString();
  s.reason = reason;
  console.error(`[kill-switch] TRIPPED — ${reason}`);
  try {
    const cancelled = await cancelAllOrders();
    const closed = await closeAllPositions(true);
    s.liquidation = { ordersCancelled: cancelled.length, positionsClosed: closed.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    s.liquidation = { ordersCancelled: 0, positionsClosed: 0, error: message };
  }
  return getKillSwitchState();
}

/** Manual re-arm. Deliberately not called by any automatic path. */
export function rearmKillSwitch(): void {
  globalThis.__killSwitch = { tripped: false };
}
