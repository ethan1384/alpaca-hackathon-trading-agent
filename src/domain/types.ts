export type AssetClass = "stock" | "crypto" | "option";

export type Timeframe = "1Min" | "5Min" | "15Min" | "30Min" | "1Hour" | "1Day";

export type DataFeed = "test" | "iex" | "sip";

export type StreamChannel = "bars" | "quotes" | "trades" | "orderbook";

export interface Bar {
  symbol: string;
  assetClass: AssetClass;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
  tradeCount?: number;
  timestamp: string;
}

export interface Quote {
  symbol: string;
  assetClass: AssetClass;
  bidPrice: number;
  bidSize: number;
  askPrice: number;
  askSize: number;
  timestamp: string;
}

export interface Trade {
  symbol: string;
  assetClass: AssetClass;
  price: number;
  size: number;
  timestamp: string;
  conditions?: string[];
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  symbol: string;
  assetClass: AssetClass;
  /** Bids sorted by price descending (best bid first). */
  bids: OrderBookLevel[];
  /** Asks sorted by price ascending (best ask first). */
  asks: OrderBookLevel[];
  timestamp: string;
}

export interface Snapshot {
  symbol: string;
  assetClass: AssetClass;
  latestTrade?: Trade;
  latestQuote?: Quote;
  minuteBar?: Bar;
  dailyBar?: Bar;
}

export interface MarketClock {
  isOpen: boolean;
  timestamp: string;
  nextOpen: string;
  nextClose: string;
}

export interface Position {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  marketValue: number;
  unrealizedPl: number;
}

export interface Order {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  status: string;
  createdAt: string;
}

export interface OptionContract {
  /** OCC symbol, e.g. `AAPL260116C00150000`. */
  symbol: string;
  underlying: string;
  /** ISO date, `YYYY-MM-DD`. */
  expiration: string;
  type: "call" | "put";
  strike: number;
}

/** Call/put filter for an option-chain query. `all` = both sides. */
export type OptionChainType = "call" | "put" | "all";

export interface OptionGreeks {
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
}

/** One row of an enriched option chain: a contract plus its latest market data. */
export interface OptionQuoteRow extends OptionContract {
  bid?: number;
  ask?: number;
  last?: number;
  /** Mid of bid/ask when both are positive. */
  mark?: number;
  /** Daily bar volume from the snapshot. */
  volume?: number;
  openInterest?: number;
  impliedVolatility?: number;
  greeks?: OptionGreeks;
  /** ISO timestamp of the freshest datapoint backing this row. */
  updatedAt?: string;
}

/** Signed distance of a strike from spot, as a fraction: `(strike - spot) / spot`. */
export function optionMoneyness(contract: Pick<OptionContract, "strike">, spot: number): number {
  return (contract.strike - spot) / spot;
}

/** True when the strike is within `pct` (fraction) of spot. */
export function isNearTheMoney(
  contract: Pick<OptionContract, "strike">,
  spot: number,
  pct: number,
): boolean {
  return Math.abs(optionMoneyness(contract, spot)) <= pct;
}

/** OCC option symbol: `{ROOT 1-6}{YYMMDD}{C|P}{STRIKE*1000, 8 digits}`. */
export const OPTION_SYMBOL_PATTERN = /^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/;

export function isOptionSymbol(symbol: string): boolean {
  return OPTION_SYMBOL_PATTERN.test(symbol);
}

export function detectAssetClass(symbol: string): AssetClass {
  if (OPTION_SYMBOL_PATTERN.test(symbol)) {
    return "option";
  }
  return symbol.includes("/") ? "crypto" : "stock";
}

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

export function parseOptionSymbol(symbol: string): OptionContract | null {
  const match = OPTION_SYMBOL_PATTERN.exec(normalizeSymbol(symbol));
  if (!match) {
    return null;
  }

  const [, underlying, yymmdd, cp, strikeRaw] = match;
  const expiration = `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;

  return {
    symbol: normalizeSymbol(symbol),
    underlying,
    expiration,
    type: cp === "C" ? "call" : "put",
    strike: Number(strikeRaw) / 1000,
  };
}

export function buildOptionSymbol(contract: Omit<OptionContract, "symbol">): string {
  const [year, month, day] = contract.expiration.split("-");
  const yymmdd = `${year.slice(2)}${month}${day}`;
  const cp = contract.type === "call" ? "C" : "P";
  const strike = Math.round(contract.strike * 1000)
    .toString()
    .padStart(8, "0");
  return `${contract.underlying.toUpperCase()}${yymmdd}${cp}${strike}`;
}

const OPTION_LABEL_MONTHS = [
  "jan.",
  "févr.",
  "mars",
  "avr.",
  "mai",
  "juin",
  "juil.",
  "août",
  "sept.",
  "oct.",
  "nov.",
  "déc.",
];

/** Human-readable label, e.g. `AAPL Call 150 $ · 16 jan. 2026`. */
export function formatOptionLabel(contract: OptionContract): string {
  const [year, month, day] = contract.expiration.split("-");
  const monthLabel = OPTION_LABEL_MONTHS[Number(month) - 1] ?? month;
  const strikeLabel = Number.isInteger(contract.strike)
    ? String(contract.strike)
    : contract.strike.toFixed(2);
  const cp = contract.type === "call" ? "Call" : "Put";
  return `${contract.underlying} ${cp} ${strikeLabel} $ · ${Number(day)} ${monthLabel} ${year}`;
}

/** OCC → readable option label; other symbols are returned as-is. */
export function displayInstrumentLabel(symbol: string): string {
  const option = parseOptionSymbol(symbol);
  return option ? formatOptionLabel(option) : symbol;
}
