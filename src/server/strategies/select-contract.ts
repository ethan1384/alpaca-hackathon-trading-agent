import "server-only";

// Shared with the competition guardrails so the DTE clamp they apply and the
// window matched here agree to the day.
import { daysToExpiration } from "@/config/competition";
import {
  chainTypeForKind,
  expectedLegCount,
  isCreditSpreadKind,
  type OptionOrderLeg,
  type StrategySignal,
} from "@/domain/strategy";
import { type OptionQuoteRow, optionMoneyness } from "@/domain/types";
import {
  getOptionChain as defaultGetOptionChain,
  listOptionExpirations as defaultListOptionExpirations,
} from "@/server/alpaca/options";

/**
 * Turns a strategy's directional thesis (`bias` + `kind` + `selection`) into
 * concrete option contracts. Injectable data access so strategies and tests run
 * without hitting Alpaca — same pattern as `MarketHubDeps`.
 */
export interface SelectContractDeps {
  listOptionExpirations: (underlying: string) => Promise<string[]>;
  getOptionChain: typeof defaultGetOptionChain;
}

const defaultDeps: SelectContractDeps = {
  listOptionExpirations: defaultListOptionExpirations,
  getOptionChain: defaultGetOptionChain,
};

/** Pick the expiration whose DTE sits inside the window and closest to its middle. */
function pickExpiration(
  expirations: string[],
  minDte: number,
  maxDte: number,
  now: Date,
): string | null {
  const target = (minDte + maxDte) / 2;
  let best: { expiration: string; distance: number } | null = null;
  for (const expiration of expirations) {
    const dte = daysToExpiration(expiration, now);
    if (dte < minDte || dte > maxDte) {
      continue;
    }
    const distance = Math.abs(dte - target);
    if (!best || distance < best.distance) {
      best = { expiration, distance };
    }
  }
  return best?.expiration ?? null;
}

function isLiquid(row: OptionQuoteRow, minOpenInterest: number, maxSpreadPct: number): boolean {
  if ((row.openInterest ?? 0) < minOpenInterest) {
    return false;
  }
  if (row.bid != null && row.ask != null && row.mark != null && row.mark > 0) {
    if ((row.ask - row.bid) / row.mark > maxSpreadPct) {
      return false;
    }
  }
  return true;
}

/**
 * Score a row against the selection criteria — lower is better.
 *
 * Delta and moneyness are two different scales and must never be mixed inside
 * one sort. They were: a row whose greeks the feed omitted fell through the
 * delta branch onto the moneyness one, where the default `want` of 0 scores
 * *at-the-money* as perfect. Missing greeks therefore beat every correctly
 * priced row — on the live 2026-08-28 SPY 1-DTE chain the deep-ITM 775 put
 * (no delta, 0.007 from ATM) outranked the 762 put the strategy actually wanted
 * (delta 0.165, 0.010 from the 0.175 target), and the "0.175-delta OTM credit
 * spread" resolved to selling a put 6 points in the money. Only the
 * credit/width sanity ceiling caught it, and only by chance.
 *
 * So: when a target delta is asked for, a row without a delta is not comparable
 * and is ranked last, never rescored on another axis.
 */
function distanceToTarget(
  row: OptionQuoteRow,
  selection: StrategySignal["selection"],
  spot: number | undefined,
): number {
  if (selection.targetDelta != null) {
    return row.greeks?.delta != null
      ? Math.abs(Math.abs(row.greeks.delta) - selection.targetDelta)
      : Number.POSITIVE_INFINITY;
  }
  if (spot != null && spot > 0) {
    const want = selection.moneyness ?? 0;
    return Math.abs(optionMoneyness(row, spot) - want);
  }
  return Number.POSITIVE_INFINITY;
}

function leg(row: OptionQuoteRow, side: "buy" | "sell"): OptionOrderLeg {
  return {
    symbol: row.symbol,
    side,
    ratioQty: 1,
    positionIntent: side === "buy" ? "buy_to_open" : "sell_to_open",
  };
}

/** Nearest available row to `wantStrike` among `rows` of the given type. */
function nearestStrike(
  rows: OptionQuoteRow[],
  type: "call" | "put",
  wantStrike: number,
): OptionQuoteRow | undefined {
  return rows
    .filter((r) => r.type === type)
    .sort((a, b) => Math.abs(a.strike - wantStrike) - Math.abs(b.strike - wantStrike))[0];
}

/**
 * The wing of a vertical, chosen so the spread is never *wider* than asked for.
 *
 * `nearestStrike` alone picks whichever liquid strike sits closest to the target,
 * and that is as happy to land outside the requested width as inside it. On a
 * live SPY chain the strike one width out is regularly the one that fails the
 * liquidity floor, so the wing lands further out and the structure silently
 * widens: a 5-point put spread resolved 762/755, which risks $663 per contract
 * instead of $463 for exactly the same credit. Width is the max-loss term of a
 * defined-risk trade — drifting it outward is a sizing decision the strategy
 * never made, so the search is bounded to strikes between the short leg
 * (exclusive) and the requested width (inclusive), and any drift left is inward,
 * i.e. less risk.
 */
function wingStrike(
  rows: OptionQuoteRow[],
  type: "call" | "put",
  shortStrike: number,
  wantStrike: number,
): OptionQuoteRow | undefined {
  const [lo, hi] = wantStrike < shortStrike ? [wantStrike, shortStrike] : [shortStrike, wantStrike];
  const bounded = rows.filter((r) => r.strike >= lo && r.strike <= hi && r.strike !== shortStrike);
  return nearestStrike(bounded, type, wantStrike);
}

/** Default vertical width when a strategy did not specify one: the local strike step. */
function inferStrikeStep(rows: OptionQuoteRow[], type: "call" | "put"): number {
  const strikes = [...new Set(rows.filter((r) => r.type === type).map((r) => r.strike))].sort(
    (a, b) => a - b,
  );
  let step = Number.POSITIVE_INFINITY;
  for (let i = 1; i < strikes.length; i += 1) {
    step = Math.min(step, strikes[i] - strikes[i - 1]);
  }
  return Number.isFinite(step) ? step : 1;
}

/**
 * Resolve `signal` to its option legs. Returns `[]` when nothing suitable exists
 * (no expiration in the DTE window, or no contract clears the liquidity floor) —
 * the caller treats that as "no trade".
 */
export async function resolveContracts(
  signal: StrategySignal,
  deps: Partial<SelectContractDeps> = {},
  now: Date = new Date(),
): Promise<OptionOrderLeg[]> {
  const { listOptionExpirations, getOptionChain } = { ...defaultDeps, ...deps };
  const { underlying, kind, selection } = signal;

  const expirations = await listOptionExpirations(underlying);
  const expiration = pickExpiration(expirations, selection.minDte, selection.maxDte, now);
  if (!expiration) {
    return [];
  }

  const chainType = chainTypeForKind(kind);
  const { spot, rows } = await getOptionChain(underlying, {
    expiration,
    type: chainType,
    moneyness:
      selection.moneyness != null
        ? Math.min(Math.abs(selection.moneyness) + 0.1, 1)
        : // credit spreads sit further OTM — widen the fetch band so both the
          // short (~0.15-0.20 delta) and long (another width out) strikes land in it.
          isCreditSpreadKind(kind)
          ? 0.2
          : 0.15,
  });

  const liquid = rows.filter((r) => isLiquid(r, selection.minOpenInterest, selection.maxSpreadPct));
  if (liquid.length === 0) {
    return [];
  }

  const longType: "call" | "put" = chainType === "put" ? "put" : "call";

  if (expectedLegCount(kind) === 1) {
    const pick = [...liquid]
      .filter((r) => r.type === longType)
      .sort(
        (a, b) => distanceToTarget(a, selection, spot) - distanceToTarget(b, selection, spot),
      )[0];
    return pick ? [leg(pick, "buy")] : [];
  }

  if (isCreditSpreadKind(kind)) {
    // Pick the SHORT leg by target delta (nearer the money), then the LONG wing
    // one width further OTM. Inverse of the debit branch below, which picks the
    // long leg first.
    const shortType: "call" | "put" = kind === "bull_put_spread" ? "put" : "call";
    const short = [...liquid]
      .filter((r) => r.type === shortType)
      .sort(
        (a, b) => distanceToTarget(a, selection, spot) - distanceToTarget(b, selection, spot),
      )[0];
    if (!short) {
      return [];
    }
    const width = selection.spreadWidth ?? inferStrikeStep(rows, shortType);
    const longWant = kind === "bull_put_spread" ? short.strike - width : short.strike + width;
    const long = wingStrike(
      liquid.filter((r) => r.symbol !== short.symbol),
      shortType,
      short.strike,
      longWant,
    );
    if (!long || long.strike === short.strike) {
      return [];
    }
    return [leg(short, "sell"), leg(long, "buy")];
  }

  if (kind === "long_straddle") {
    const call = [...liquid]
      .filter((r) => r.type === "call")
      .sort(
        (a, b) => distanceToTarget(a, selection, spot) - distanceToTarget(b, selection, spot),
      )[0];
    if (!call) {
      return [];
    }
    const put = nearestStrike(liquid, "put", call.strike);
    return put ? [leg(call, "buy"), leg(put, "buy")] : [];
  }

  // Vertical spreads: pick the long leg, then the short leg one width away.
  const long = [...liquid]
    .filter((r) => r.type === longType)
    .sort((a, b) => distanceToTarget(a, selection, spot) - distanceToTarget(b, selection, spot))[0];
  if (!long) {
    return [];
  }
  const width = selection.spreadWidth ?? inferStrikeStep(rows, longType);
  const shortWant = kind === "bull_call_spread" ? long.strike + width : long.strike - width;
  const short = wingStrike(
    liquid.filter((r) => r.symbol !== long.symbol),
    longType,
    long.strike,
    shortWant,
  );
  if (!short || short.strike === long.strike) {
    return [];
  }
  return [leg(long, "buy"), leg(short, "sell")];
}
