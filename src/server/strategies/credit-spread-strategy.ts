import "server-only";

import { AGENT } from "@/config/agent";
import { daysToExpiration, isExpirationWithinWindow } from "@/config/competition";
import { quoteAnomalies } from "@/config/risk";
import type { RejectedAlternative } from "@/domain/decision";
import { type OptionOrderLeg, type StrategySignal, StrategySignalSchema } from "@/domain/strategy";
import type { TradingAccount } from "@/domain/trading";
import { type OptionQuoteRow, parseOptionSymbol } from "@/domain/types";
import { getAlpacaRestClient } from "@/server/alpaca/client";
import { getOptionSnapshots as defaultGetOptionSnapshots } from "@/server/alpaca/options";
import { getHistoricalBars as defaultGetHistoricalBars } from "@/server/alpaca/rest";
import { getTradingAccount as defaultGetTradingAccount } from "@/server/alpaca/trading";
import { realisedVolatility } from "@/server/backtest/black-scholes";
import {
  resolveContracts as defaultResolveContracts,
  type SelectContractDeps,
} from "./select-contract";

/**
 * The mechanical half of the agent: given the live chain and the account, build
 * one structural put-credit-spread candidate for SPY and size it. No LLM — the
 * model only ever vetoes what this produces (see `src/server/agent/run-cycle.ts`).
 *
 * Preconditions are ported from the credit-spread backtest
 * (`src/server/backtest/credit-spread-entry.ts`, docs/07): a minimum credit that
 * acts as an implicit IV floor, a credit/width sanity ceiling, a short-delta
 * ceiling, and 1% risk per spread capped by `maxConcurrentSpreads`.
 */

export interface CreditSpreadRationale {
  spot: number;
  realisedVol: number | null;
  /** Closing prices of the last `RECENT_CLOSES` sessions, oldest first. */
  recentCloses: number[];
  expiration: string;
  dte: number;
  shortStrike: number;
  longStrike: number;
  width: number;
  shortDelta: number | null;
  /** Implied volatility of the short leg, as quoted. Null when the feed omits it. */
  shortIv: number | null;
  midCredit: number;
  entryLimit: number;
  creditRatio: number;
}

export interface CreditSpreadSizing {
  contracts: number;
  riskAmount: number;
  pctOfEquity: number;
  maxLossPerSpread: number;
}

export interface CreditSpreadCandidate {
  signal: StrategySignal;
  sizing: CreditSpreadSizing;
  rationale: CreditSpreadRationale;
  rejected: RejectedAlternative[];
}

export type CreditSpreadSkip =
  | "no_realised_vol_history"
  | "no_contracts_in_window"
  | "expiry_too_near_snapshot"
  | "expiry_past_snapshot"
  | "unpriceable_chain"
  | "credit_below_min"
  | "credit_ratio_implausible"
  | "credit_ratio_too_thin"
  | "short_strike_too_close"
  | "size_below_one_contract"
  | "account_equity_unavailable";

export type CreditSpreadOutcome =
  | { ok: true; candidate: CreditSpreadCandidate }
  | {
      ok: false;
      skip: CreditSpreadSkip;
      rejected: RejectedAlternative[];
      detail?: Record<string, unknown>;
    };

export interface CreditSpreadDeps extends Partial<SelectContractDeps> {
  resolveContracts?: typeof defaultResolveContracts;
  getHistoricalBars?: typeof defaultGetHistoricalBars;
  getOptionSnapshots?: typeof defaultGetOptionSnapshots;
  getSpot?: (underlying: string) => Promise<number | undefined>;
  getTradingAccount?: () => Promise<TradingAccount>;
}

async function defaultGetSpot(underlying: string): Promise<number | undefined> {
  return getAlpacaRestClient()
    .marketData.getLatestPrice(underlying)
    .catch(() => undefined);
}

/**
 * How many daily closes travel to the LLM. Enough for it to see lower highs /
 * lower lows without burning the context on a month of prices.
 */
const RECENT_CLOSES = 10;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function legMid(row: OptionQuoteRow | undefined): number | null {
  if (!row) {
    return null;
  }
  if (row.bid != null && row.ask != null && row.bid > 0 && row.ask >= row.bid) {
    return (row.bid + row.ask) / 2;
  }
  return row.mark ?? null;
}

const REJECT_OTHER_SIDE: RejectedAlternative = {
  what: "bear_call_spread (call side)",
  why: "the agent trades the put credit side only, per src/config/agent.ts",
};

/**
 * Build a put-credit-spread candidate, or explain why not.
 *
 * @param openManagedCount how many agent spreads are already open (caps sizing).
 */
export async function buildCreditSpreadCandidate(
  deps: CreditSpreadDeps = {},
  openManagedCount = 0,
  now: Date = new Date(),
): Promise<CreditSpreadOutcome> {
  const resolve = deps.resolveContracts ?? defaultResolveContracts;
  const getHistoricalBars = deps.getHistoricalBars ?? defaultGetHistoricalBars;
  const getOptionSnapshots = deps.getOptionSnapshots ?? defaultGetOptionSnapshots;
  const getSpot = deps.getSpot ?? defaultGetSpot;
  const getTradingAccount = deps.getTradingAccount ?? defaultGetTradingAccount;

  const rejected: RejectedAlternative[] = [REJECT_OTHER_SIDE];

  const account = await getTradingAccount().catch(() => null);
  if (!account || !(account.equity > 0)) {
    return { ok: false, skip: "account_equity_unavailable", rejected };
  }
  const equity = account.equity;

  const dailyBars = await getHistoricalBars(AGENT.underlying, "1Day", 30).catch(() => []);
  const closes = dailyBars.map((b) => b.close);
  const realisedVol = realisedVolatility(closes);
  const recentCloses = closes.slice(-RECENT_CLOSES);

  const unresolved = StrategySignalSchema.parse({
    strategy: AGENT.strategy,
    underlying: AGENT.underlying,
    bias: AGENT.bias,
    kind: AGENT.kind,
    selection: {
      targetDelta: AGENT.targetDelta,
      minDte: AGENT.minDte,
      maxDte: AGENT.maxDte,
      minOpenInterest: AGENT.minOpenInterest,
      maxSpreadPct: AGENT.maxSpreadPct,
      spreadWidth: AGENT.spreadWidth,
    },
    confidence: 0.5,
    reason: "mechanical put credit spread candidate",
    maxContracts: 1,
    timestamp: now.toISOString(),
  });

  const legs = await resolve(unresolved, deps, now);
  if (legs.length !== 2) {
    return { ok: false, skip: "no_contracts_in_window", rejected };
  }

  const parsed = legs.map((l) => ({ leg: l, contract: parseOptionSymbol(l.symbol) }));
  const shortLeg = parsed.find((p) => p.leg.side === "sell");
  const longLeg = parsed.find((p) => p.leg.side === "buy");
  if (!shortLeg?.contract || !longLeg?.contract) {
    return { ok: false, skip: "no_contracts_in_window", rejected };
  }

  const expiration = shortLeg.contract.expiration;
  const dte = daysToExpiration(expiration, now);
  if (!isExpirationWithinWindow(expiration)) {
    return { ok: false, skip: "expiry_past_snapshot", rejected, detail: { expiration } };
  }
  if (dte < AGENT.minDte) {
    return { ok: false, skip: "expiry_too_near_snapshot", rejected, detail: { expiration, dte } };
  }

  const shortStrike = shortLeg.contract.strike;
  const longStrike = longLeg.contract.strike;
  const width = Math.abs(shortStrike - longStrike);

  const snapshots = await getOptionSnapshots([shortLeg.leg.symbol, longLeg.leg.symbol]);
  const shortRow = snapshots.get(shortLeg.leg.symbol);
  const longRow = snapshots.get(longLeg.leg.symbol);
  const shortMid = legMid(shortRow);
  const longMid = legMid(longRow);

  const anomalies = [
    ...(shortRow ? quoteAnomalies(shortRow, now) : ["short leg: no snapshot"]),
    ...(longRow ? quoteAnomalies(longRow, now) : ["long leg: no snapshot"]),
  ];
  if (shortMid == null || longMid == null || anomalies.length > 0) {
    return { ok: false, skip: "unpriceable_chain", rejected, detail: { anomalies } };
  }

  const midCredit = shortMid - longMid;
  const entryLimit = round2(midCredit - AGENT.limitCushion);
  const creditRatio = midCredit / width;
  const shortDelta = shortRow?.greeks?.delta != null ? Math.abs(shortRow.greeks.delta) : null;
  const shortIv = shortRow?.impliedVolatility ?? null;

  const rationale: CreditSpreadRationale = {
    spot: (await getSpot(AGENT.underlying)) ?? shortStrike,
    realisedVol,
    recentCloses,
    expiration,
    dte,
    shortStrike,
    longStrike,
    width,
    shortDelta,
    shortIv,
    midCredit: round2(midCredit),
    entryLimit,
    creditRatio: round2(creditRatio),
  };

  if (entryLimit < AGENT.minCredit) {
    return {
      ok: false,
      skip: "credit_below_min",
      rejected,
      detail: { entryLimit, minCredit: AGENT.minCredit },
    };
  }
  if (creditRatio > AGENT.maxCreditRatio || width - entryLimit <= 0) {
    return {
      ok: false,
      skip: "credit_ratio_implausible",
      rejected,
      detail: { creditRatio: rationale.creditRatio, width },
    };
  }
  // Floor on the credit we would actually collect (post-cushion), not the mid.
  // A spread paying too little relative to its width is negative-EV before it
  // ever reaches the LLM — see AGENT.minCreditRatio.
  const netCreditRatio = entryLimit / width;
  if (netCreditRatio < AGENT.minCreditRatio) {
    return {
      ok: false,
      skip: "credit_ratio_too_thin",
      rejected,
      detail: {
        netCreditRatio: round2(netCreditRatio),
        minCreditRatio: AGENT.minCreditRatio,
      },
    };
  }
  if (shortDelta != null && shortDelta > AGENT.shortDeltaMax) {
    return {
      ok: false,
      skip: "short_strike_too_close",
      rejected,
      detail: { shortDelta, shortDeltaMax: AGENT.shortDeltaMax },
    };
  }

  const maxLossPerSpread = width - entryLimit;
  const perSpreadRisk = maxLossPerSpread * 100;
  // `maxConcurrentSpreads` counts *positions*, not contracts — the caller already
  // refuses the entry once that many are open (`run-cycle.ts`). Sizing is bounded
  // by the risk budget alone; using the position cap here as a contract ceiling
  // silently truncated the position below the 1%-of-equity budget it is allowed.
  const contracts = Math.max(0, Math.floor((equity * AGENT.riskPerSidePct) / perSpreadRisk));
  if (openManagedCount >= AGENT.maxConcurrentSpreads || contracts < 1) {
    return {
      ok: false,
      skip: "size_below_one_contract",
      rejected,
      detail: { contracts, openManagedCount, perSpreadRisk },
    };
  }

  const orderedLegs: OptionOrderLeg[] = [shortLeg.leg, longLeg.leg];
  const signal = StrategySignalSchema.parse({
    ...unresolved,
    resolvedLegs: orderedLegs,
    maxContracts: contracts,
    entryLimit,
    orderType: AGENT.creditEntryOrderType,
    underlyingStop: shortStrike,
    confidence: 0.5,
    reason: `put credit spread ${shortStrike}/${longStrike} exp ${expiration}, credit ${entryLimit.toFixed(2)}`,
  });

  const riskAmount = perSpreadRisk * contracts;
  return {
    ok: true,
    candidate: {
      signal,
      sizing: {
        contracts,
        riskAmount,
        pctOfEquity: riskAmount / equity,
        maxLossPerSpread,
      },
      rationale,
      rejected,
    },
  };
}
