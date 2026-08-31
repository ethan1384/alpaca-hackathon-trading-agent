import "server-only";

import {
  aggregateExposure,
  type CandidatePosition,
  type PortfolioExposure,
  type PositionExposure,
} from "@/config/risk";
import { isCreditSpreadKind, type OptionOrderLeg, type StrategySignal } from "@/domain/strategy";
import type { TradingAccount, TradingPosition } from "@/domain/trading";
import { parseOptionSymbol } from "@/domain/types";
import { getAlpacaRestClient } from "@/server/alpaca/client";
import { getOptionSnapshots as defaultGetOptionSnapshots } from "@/server/alpaca/options";
import {
  getTradingAccount as defaultGetTradingAccount,
  listPositions as defaultListPositions,
} from "@/server/alpaca/trading";

/**
 * Builds the `PortfolioExposure` the risk caps are evaluated against.
 *
 * The account API tells us *what* we hold and what it is worth; it does not
 * report greeks. Net delta and net vega ([K1]/[K2]) therefore require a second
 * call, pricing each open contract off the option snapshot. Where that call
 * comes back without a greek, the aggregate degrades to `null` and the
 * corresponding cap reports "not checked" rather than passing — see the design
 * rule in `src/config/risk.ts`.
 */

export interface ExposureDeps {
  getTradingAccount: () => Promise<TradingAccount>;
  listPositions: () => Promise<TradingPosition[]>;
  getOptionSnapshots: typeof defaultGetOptionSnapshots;
  getSpot: (underlying: string) => Promise<number | undefined>;
}

async function defaultGetSpot(underlying: string): Promise<number | undefined> {
  return getAlpacaRestClient()
    .marketData.getLatestPrice(underlying)
    .catch(() => undefined);
}

const defaultDeps: ExposureDeps = {
  getTradingAccount: defaultGetTradingAccount,
  listPositions: defaultListPositions,
  getOptionSnapshots: defaultGetOptionSnapshots,
  getSpot: defaultGetSpot,
};

/** Signed contract count — Alpaca reports `qty` unsigned alongside a `side`. */
function signedContracts(position: TradingPosition): number {
  return position.side === "short" ? -Math.abs(position.qty) : Math.abs(position.qty);
}

/**
 * Capital at risk on an existing line.
 *
 * Long premium: what it cost, which is genuinely the most that can be lost.
 * Short premium: unbounded in the general case, so it is reported as `null`
 * rather than guessed. A short leg's true risk is only defined by the long leg
 * that caps it, and the position API reports legs individually — it does not
 * tell us which ones form a spread. `null` propagates to a [K4] warning, which
 * is the correct signal: this book contains a risk the system cannot quantify.
 */
function riskAmountOf(position: TradingPosition): number | null {
  if (signedContracts(position) > 0) {
    return Math.abs(position.costBasis ?? position.marketValue ?? 0) || null;
  }
  return null;
}

/** Fold the account's open option positions into the aggregate risk state. */
export async function buildPortfolioExposure(
  deps: Partial<ExposureDeps> = {},
): Promise<PortfolioExposure> {
  const { getTradingAccount, listPositions, getOptionSnapshots, getSpot } = {
    ...defaultDeps,
    ...deps,
  };

  const [account, positions] = await Promise.all([getTradingAccount(), listPositions()]);

  const optionPositions = positions.filter((p) => parseOptionSymbol(p.symbol) != null);
  const snapshots = await getOptionSnapshots(optionPositions.map((p) => p.symbol));

  const underlyings = [
    ...new Set(optionPositions.map((p) => parseOptionSymbol(p.symbol)?.underlying).filter(Boolean)),
  ] as string[];
  const spots = new Map<string, number | undefined>(
    await Promise.all(
      underlyings.map(async (u) => [u, await getSpot(u)] as [string, number | undefined]),
    ),
  );

  const exposures: PositionExposure[] = optionPositions.map((position) => {
    const contract = parseOptionSymbol(position.symbol);
    const underlying = contract?.underlying ?? position.symbol;
    const snap = snapshots.get(position.symbol);
    return {
      symbol: position.symbol,
      underlying,
      contracts: signedContracts(position),
      marketValue: position.marketValue ?? 0,
      riskAmount: riskAmountOf(position),
      delta: snap?.greeks?.delta ?? null,
      vega: snap?.greeks?.vega ?? null,
      spot: spots.get(underlying) ?? null,
    };
  });

  return aggregateExposure(exposures, account, spots.get("SPY") ?? undefined);
}

/**
 * Price a signal that has not been sent yet, so [K1]/[K2]/[K4] can be checked
 * *before* the order goes out rather than discovered after the fill.
 *
 * `riskAmount` is the maximum loss the position could take:
 * - debit / long structures — `entryLimit × 100 × contracts` (the debit paid);
 * - credit spreads — `(width − entryLimit) × 100 × contracts` (width from the
 *   two leg strikes), because `entryLimit` there is the credit *received*, not
 *   the loss.
 * When the signal carries no `entryLimit` (a market order), or a credit spread's
 * width cannot be read, `riskAmount` is `null`, which [K4] treats as a
 * violation — [P18] says limit at mid, never market, and an unpriced order is
 * exactly the case the cap exists for.
 */
export async function priceCandidate(
  signal: StrategySignal,
  legs: OptionOrderLeg[],
  deps: Partial<ExposureDeps> = {},
): Promise<CandidatePosition> {
  const { getOptionSnapshots, getSpot } = { ...defaultDeps, ...deps };

  const snapshots = await getOptionSnapshots(legs.map((l) => l.symbol));
  const spot = await getSpot(signal.underlying);

  let deltaNotional: number | null = 0;
  let vegaUsd: number | null = 0;

  for (const leg of legs) {
    const sign = leg.side === "buy" ? 1 : -1;
    const contracts = sign * leg.ratioQty * signal.maxContracts;
    const greeks = snapshots.get(leg.symbol)?.greeks;

    if (deltaNotional !== null) {
      deltaNotional =
        greeks?.delta == null || spot == null
          ? null
          : deltaNotional + greeks.delta * 100 * contracts * spot;
    }
    if (vegaUsd !== null) {
      vegaUsd = greeks?.vega == null ? null : vegaUsd + greeks.vega * 100 * contracts;
    }
  }

  return {
    underlying: signal.underlying,
    riskAmount: candidateRiskAmount(signal, legs),
    deltaNotional,
    vegaUsd,
  };
}

/** Max loss (USD) for the proposed position, or `null` when it can't be priced. */
function candidateRiskAmount(signal: StrategySignal, legs: OptionOrderLeg[]): number | null {
  if (signal.entryLimit == null) {
    return null;
  }
  if (!isCreditSpreadKind(signal.kind)) {
    return signal.entryLimit * 100 * signal.maxContracts;
  }
  const strikes = legs
    .map((l) => parseOptionSymbol(l.symbol)?.strike)
    .filter((s): s is number => s != null);
  if (strikes.length < 2) {
    return null;
  }
  const width = Math.max(...strikes) - Math.min(...strikes);
  const maxLossPerSpread = width - signal.entryLimit;
  if (maxLossPerSpread <= 0) {
    return null;
  }
  return maxLossPerSpread * 100 * signal.maxContracts;
}
