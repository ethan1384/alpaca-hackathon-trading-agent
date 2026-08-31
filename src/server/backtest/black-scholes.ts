/**
 * Black-Scholes pricing for the backtest's structure layer.
 *
 * Pure and dependency-free — no `server-only`, so tests and any future client
 * preview can both use it. Prices are per share; a contract is 100 of them.
 *
 * The model is used here for one reason: it prices a strike that never traded.
 * A 0DTE chain has hundreds of strikes and only a handful print in any given
 * minute, so a path-following backtest cannot be driven by trade data.
 */

export type OptionType = "call" | "put";

/** Abramowitz & Stegun 26.2.17 — accurate to ~7.5e-8, ample for this. */
export function cumulativeNormal(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

/** Below this many years to expiry an option is worth its intrinsic value. */
const MIN_T = 1e-8;

function d1(spot: number, strike: number, t: number, rate: number, iv: number): number {
  return (Math.log(spot / strike) + (rate + (iv * iv) / 2) * t) / (iv * Math.sqrt(t));
}

function intrinsic(type: OptionType, spot: number, strike: number): number {
  return type === "call" ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
}

/** Black-Scholes price of a European option. `t` in years, `iv` annualised. */
export function optionPrice(
  type: OptionType,
  spot: number,
  strike: number,
  t: number,
  rate: number,
  iv: number,
): number {
  if (t <= MIN_T || iv <= 0) {
    return intrinsic(type, spot, strike);
  }
  const a = d1(spot, strike, t, rate, iv);
  const b = a - iv * Math.sqrt(t);
  const discount = Math.exp(-rate * t);
  return type === "call"
    ? spot * cumulativeNormal(a) - strike * discount * cumulativeNormal(b)
    : strike * discount * cumulativeNormal(-b) - spot * cumulativeNormal(-a);
}

/** Delta. Positive for a call (0..1), negative for a put (-1..0). */
export function optionDelta(
  type: OptionType,
  spot: number,
  strike: number,
  t: number,
  rate: number,
  iv: number,
): number {
  if (t <= MIN_T || iv <= 0) {
    const itm = type === "call" ? spot > strike : spot < strike;
    if (!itm) {
      return 0;
    }
    return type === "call" ? 1 : -1;
  }
  const nd1 = cumulativeNormal(d1(spot, strike, t, rate, iv));
  return type === "call" ? nd1 : nd1 - 1;
}

/**
 * Net value of a debit vertical, per share. Always ≥ 0 and ≤ width: long the
 * near strike, short the far one, both the same type and expiry.
 */
export function verticalValue(
  type: OptionType,
  spot: number,
  longStrike: number,
  shortStrike: number,
  t: number,
  rate: number,
  iv: number,
): number {
  const long = optionPrice(type, spot, longStrike, t, rate, iv);
  const short = optionPrice(type, spot, shortStrike, t, rate, iv);
  const width = Math.abs(longStrike - shortStrike);
  return Math.min(Math.max(long - short, 0), width);
}

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

/** Year fraction between two instants, floored at zero. */
export function yearsBetween(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / MS_PER_YEAR);
}

/**
 * Annualised realised volatility from a series of closes (close-to-close).
 * Returns `null` when there are too few points to form a sample.
 */
export function realisedVolatility(closes: number[]): number | null {
  if (closes.length < 3) {
    return null;
  }
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    if (closes[i - 1] > 0 && closes[i] > 0) {
      returns.push(Math.log(closes[i] / closes[i - 1]));
    }
  }
  if (returns.length < 2) {
    return null;
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((acc, r) => acc + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252);
}

/**
 * Strike nearest `targetDelta` on the given side, searched outward from spot on
 * the `step` grid. Returns the strike whose |delta| is closest to the target.
 */
export function strikeForDelta(
  type: OptionType,
  spot: number,
  targetDelta: number,
  t: number,
  rate: number,
  iv: number,
  step: number,
  searchSteps = 40,
): number {
  const atm = Math.round(spot / step) * step;
  let best = atm;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = -searchSteps; i <= searchSteps; i += 1) {
    const strike = atm + i * step;
    if (strike <= 0) {
      continue;
    }
    const delta = Math.abs(optionDelta(type, spot, strike, t, rate, iv));
    const distance = Math.abs(delta - targetDelta);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = strike;
    }
  }
  return best;
}

/**
 * Net value of a *credit* vertical, per share: short the near strike, long the
 * far one. Always ≥ 0 and ≤ width — this is the cost to buy the spread back,
 * so the seller's P&L is `credit - creditSpreadValue(...)`.
 *
 * Deliberately a separate function from `verticalValue` rather than the same
 * one with the arguments swapped. Getting the two strikes the wrong way round
 * silently returns 0 instead of erroring, and on a premium-selling backtest
 * that reads as a free win on every trade.
 */
export function creditSpreadValue(
  type: OptionType,
  spot: number,
  shortStrike: number,
  longStrike: number,
  t: number,
  rate: number,
  iv: number,
): number {
  const short = optionPrice(type, spot, shortStrike, t, rate, iv);
  const long = optionPrice(type, spot, longStrike, t, rate, iv);
  const width = Math.abs(shortStrike - longStrike);
  return Math.min(Math.max(short - long, 0), width);
}

/** Regular-hours minutes in one session (09:30–16:00 ET). */
export const TRADING_MINUTES_PER_SESSION = 390;
export const TRADING_SESSIONS_PER_YEAR = 252;

/**
 * Year fraction from a count of *trading* minutes.
 *
 * Not the same clock as `yearsBetween`, and the difference is not cosmetic.
 * Realised vol here is annualised over 252 sessions, so time to expiry has to
 * be measured on the same calendar or σ√t is wrong. Calendar time says the
 * 78 hours from a Friday 10:00 entry to a Monday 16:00 expiry carry three days
 * of variance; the market is shut for two of them, and it carries two sessions.
 */
export function tradingYears(minutes: number): number {
  return Math.max(0, minutes) / (TRADING_SESSIONS_PER_YEAR * TRADING_MINUTES_PER_SESSION);
}
