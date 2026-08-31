import type {
  OrderClass,
  OrderSide,
  OrderType,
  PositionIntent,
  TimeInForce,
  TradingAccount,
  TradingOrder,
  TradingPosition,
} from "@/domain/trading";

/**
 * The Alpaca trading SDK models responses as camelCase objects but types every
 * monetary field as a `string`. This module is the single boundary that turns
 * those raw SDK shapes into the numeric domain models the app and MCP consume.
 */

type Raw = Record<string, unknown>;

function num(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function iso(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function normalizeOrder(raw: Raw): TradingOrder {
  const legsRaw = Array.isArray(raw.legs) ? (raw.legs as Raw[]) : undefined;

  return {
    id: String(raw.id ?? ""),
    clientOrderId: str(raw.clientOrderId),
    symbol: String(raw.symbol ?? ""),
    assetClass: str(raw.assetClass),
    side: str(raw.side) as OrderSide | undefined,
    type: (str(raw.type) ?? str(raw.orderType) ?? "market") as OrderType,
    orderClass: (str(raw.orderClass) || undefined) as OrderClass | undefined,
    timeInForce: (str(raw.timeInForce) ?? "day") as TimeInForce,
    status: String(raw.status ?? "unknown"),
    qty: num(raw.qty),
    notional: num(raw.notional),
    filledQty: num(raw.filledQty) ?? 0,
    filledAvgPrice: num(raw.filledAvgPrice),
    limitPrice: num(raw.limitPrice),
    stopPrice: num(raw.stopPrice),
    trailPrice: num(raw.trailPrice),
    trailPercent: num(raw.trailPercent),
    extendedHours: typeof raw.extendedHours === "boolean" ? raw.extendedHours : undefined,
    positionIntent: str(raw.positionIntent) as PositionIntent | undefined,
    createdAt: iso(raw.createdAt),
    submittedAt: iso(raw.submittedAt),
    filledAt: iso(raw.filledAt),
    canceledAt: iso(raw.canceledAt),
    updatedAt: iso(raw.updatedAt),
    legs: legsRaw?.map(normalizeOrder),
  };
}

export function normalizePosition(raw: Raw): TradingPosition {
  const qty = num(raw.qty) ?? 0;
  return {
    symbol: String(raw.symbol ?? ""),
    assetClass: str(raw.assetClass),
    side: (str(raw.side) as "long" | "short" | undefined) ?? (qty < 0 ? "short" : "long"),
    qty,
    qtyAvailable: num(raw.qtyAvailable),
    avgEntryPrice: num(raw.avgEntryPrice) ?? 0,
    currentPrice: num(raw.currentPrice),
    lastdayPrice: num(raw.lastdayPrice),
    marketValue: num(raw.marketValue),
    costBasis: num(raw.costBasis),
    unrealizedPl: num(raw.unrealizedPl),
    unrealizedPlpc: num(raw.unrealizedPlpc),
    unrealizedIntradayPl: num(raw.unrealizedIntradayPl),
    unrealizedIntradayPlpc: num(raw.unrealizedIntradayPlpc),
    changeToday: num(raw.changeToday),
  };
}

export function normalizeAccount(raw: Raw): TradingAccount {
  return {
    id: String(raw.id ?? ""),
    accountNumber: str(raw.accountNumber),
    status: String(raw.status ?? "unknown"),
    currency: str(raw.currency) ?? "USD",
    cash: num(raw.cash) ?? 0,
    equity: num(raw.equity) ?? 0,
    lastEquity: num(raw.lastEquity),
    buyingPower: num(raw.buyingPower) ?? 0,
    regtBuyingPower: num(raw.regtBuyingPower),
    daytradingBuyingPower: num(raw.daytradingBuyingPower),
    nonMarginableBuyingPower: num(raw.nonMarginableBuyingPower),
    optionsBuyingPower: num(raw.optionsBuyingPower),
    portfolioValue: num(raw.portfolioValue),
    longMarketValue: num(raw.longMarketValue),
    shortMarketValue: num(raw.shortMarketValue),
    initialMargin: num(raw.initialMargin),
    maintenanceMargin: num(raw.maintenanceMargin),
    daytradeCount: num(raw.daytradeCount),
    patternDayTrader: typeof raw.patternDayTrader === "boolean" ? raw.patternDayTrader : undefined,
    tradingBlocked: typeof raw.tradingBlocked === "boolean" ? raw.tradingBlocked : undefined,
    transfersBlocked: typeof raw.transfersBlocked === "boolean" ? raw.transfersBlocked : undefined,
    accountBlocked: typeof raw.accountBlocked === "boolean" ? raw.accountBlocked : undefined,
    shortingEnabled: typeof raw.shortingEnabled === "boolean" ? raw.shortingEnabled : undefined,
    optionsTradingLevel: num(raw.optionsTradingLevel),
    optionsApprovedLevel: num(raw.optionsApprovedLevel),
  };
}
