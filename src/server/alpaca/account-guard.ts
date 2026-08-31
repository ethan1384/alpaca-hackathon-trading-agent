import "server-only";

import { COMPETITION } from "@/config/competition";
import { getEnv } from "@/config/env";
import type { TradingAccount } from "@/domain/trading";
import { getTradingAccount as defaultGetTradingAccount } from "./trading";

/**
 * [R1]/[R2] The official P&L must be measured on a dedicated $100,000 paper
 * account, never the development account. A stale `.env` is the realistic way
 * that goes wrong, so pin the account number in `COMPETITION_ACCOUNT_NUMBER`
 * and check it before trading. See `docs/05-hackathon-rules.md`.
 */

export interface AccountGuardResult {
  ok: boolean;
  account: TradingAccount;
  /** Hard breaches — trading the wrong account, live mode, blocked account. */
  violations: string[];
  /** Advisory — e.g. an options level too low for the strategies in use. */
  warnings: string[];
}

export interface AccountGuardDeps {
  getTradingAccount?: () => Promise<TradingAccount>;
}

/** Options approval level required to buy long calls/puts. */
const MIN_OPTIONS_LEVEL_LONG = 2;
/** Options approval level required for the vertical spreads this repo emits. */
const MIN_OPTIONS_LEVEL_SPREADS = 3;

export async function checkCompetitionAccount(
  deps: AccountGuardDeps = {},
): Promise<AccountGuardResult> {
  const account = await (deps.getTradingAccount ?? defaultGetTradingAccount)();
  const env = getEnv();
  const violations: string[] = [];
  const warnings: string[] = [];

  if (!env.ALPACA_PAPER) {
    violations.push("ALPACA_PAPER is not true — the competition runs on a paper account only");
  }

  const expected = env.COMPETITION_ACCOUNT_NUMBER;
  if (expected) {
    if (account.accountNumber !== expected) {
      violations.push(
        `connected to account ${account.accountNumber ?? "(unknown)"}, expected the competition account ${expected} — the testing account must not be used for the official measurement`,
      );
    }
  } else {
    warnings.push(
      "COMPETITION_ACCOUNT_NUMBER is unset — nothing pins this run to the official competition account",
    );
  }

  if (account.accountBlocked || account.tradingBlocked) {
    violations.push(`account ${account.accountNumber ?? account.id} is blocked from trading`);
  }

  const level = account.optionsTradingLevel;
  if (level != null) {
    if (level < MIN_OPTIONS_LEVEL_LONG) {
      violations.push(
        `options trading level ${level} cannot buy long calls/puts (need ${MIN_OPTIONS_LEVEL_LONG})`,
      );
    } else if (level < MIN_OPTIONS_LEVEL_SPREADS) {
      warnings.push(
        `options trading level ${level} cannot place vertical spreads (need ${MIN_OPTIONS_LEVEL_SPREADS}) — single-leg strategies only`,
      );
    }
  }

  // [R3] Judged on total equity, never cash. Flag an account that clearly did
  // not start from the required balance.
  if (account.equity > 0 && account.equity < COMPETITION.startingEquity * 0.5) {
    warnings.push(
      `equity ${account.equity} is far below the required ${COMPETITION.startingEquity} starting balance — is this the right account?`,
    );
  }

  return { ok: violations.length === 0, account, violations, warnings };
}

/**
 * Same check, but throws when a hard rule is broken and enforcement is on.
 * Returns the account so callers can reuse the snapshot.
 */
export async function assertCompetitionAccount(
  deps: AccountGuardDeps = {},
): Promise<TradingAccount> {
  const result = await checkCompetitionAccount(deps);
  for (const warning of result.warnings) {
    console.warn(`[account-guard] ${warning}`);
  }
  if (!result.ok && getEnv().COMPETITION_ENFORCE) {
    throw new Error(`Competition account guard: ${result.violations.join("; ")}`);
  }
  return result.account;
}
