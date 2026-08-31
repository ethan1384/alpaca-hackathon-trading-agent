import "server-only";

import {
  type ClosePositionInput,
  deriveOrderClass,
  type ListOrdersQuery,
  type PlaceOrderInput,
  type ReplaceOrderInput,
  type TradingAccount,
  type TradingOrder,
  type TradingPosition,
} from "@/domain/trading";
import { getAlpacaRestClient } from "./client";
import { normalizeAccount, normalizeOrder, normalizePosition } from "./normalize-trading";
import { withRetry } from "./retry";

type Raw = Record<string, unknown>;

function trading() {
  return getAlpacaRestClient().trading;
}

// --- Account ---------------------------------------------------------------

export async function getTradingAccount(): Promise<TradingAccount> {
  const account = await trading().account.getAccount();
  return normalizeAccount(account as unknown as Raw);
}

// --- Positions -----------------------------------------------------------

export async function listPositions(): Promise<TradingPosition[]> {
  const positions = await trading().positions.getAllOpenPositions();
  return (positions as unknown as Raw[]).map(normalizePosition);
}

export async function getPosition(symbol: string): Promise<TradingPosition> {
  const position = await trading().positions.getOpenPosition({ symbolOrAssetId: symbol });
  return normalizePosition(position as unknown as Raw);
}

export async function closePosition(
  symbol: string,
  input: ClosePositionInput = {},
): Promise<TradingOrder> {
  const order = await trading().positions.deleteOpenPosition({
    symbolOrAssetId: symbol,
    qty: input.qty,
    percentage: input.percentage,
  });
  return normalizeOrder(order as unknown as Raw);
}

export async function closeAllPositions(cancelOrders = false): Promise<unknown[]> {
  return trading().closeAllPositions({ cancelOrders });
}

// --- Orders -------------------------------------------------------------

export async function listOrders(query: ListOrdersQuery): Promise<TradingOrder[]> {
  const orders = await trading().orders.getAllOrders({
    status: query.status,
    limit: query.limit,
    direction: query.direction,
    nested: query.nested,
    symbols: query.symbols,
    side: query.side,
    after: query.after,
    until: query.until,
  });
  return (orders as unknown as Raw[]).map(normalizeOrder);
}

export async function getOrder(orderId: string, nested = true): Promise<TradingOrder> {
  const order = await trading().orders.getOrderByOrderID({ orderId, nested } as never);
  return normalizeOrder(order as unknown as Raw);
}

/**
 * [O4] Submit an order, retrying transient venue failures.
 *
 * Every submission carries a `clientOrderId`: Alpaca rejects a duplicate, so a
 * retry after a lost response can only ever produce a duplicate rejection, never
 * a second fill. Without that key a retry is a double-fill risk, which is why it
 * is generated here rather than left to the caller to remember.
 */
export async function placeOrder(input: PlaceOrderInput): Promise<TradingOrder> {
  const withKey: PlaceOrderInput = {
    ...input,
    clientOrderId:
      input.clientOrderId ?? `agent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  };
  return withRetry(() => submitOrder(withKey), { operation: "placeOrder" });
}

async function submitOrder(input: PlaceOrderInput): Promise<TradingOrder> {
  const orderClass = deriveOrderClass(input);
  const order = await trading().orders.submit({
    type: input.type,
    symbol: input.symbol,
    side: input.side,
    timeInForce: input.timeInForce,
    orderClass: orderClass === "simple" ? undefined : orderClass,
    qty: input.qty,
    notional: input.notional,
    limitPrice: input.limitPrice,
    stopPrice: input.stopPrice,
    trailPrice: input.trailPrice,
    trailPercent: input.trailPercent,
    extendedHours: input.extendedHours,
    clientOrderId: input.clientOrderId,
    positionIntent: input.positionIntent,
    takeProfit: input.takeProfit,
    stopLoss: input.stopLoss,
    legs: input.legs?.map((leg) => ({
      symbol: leg.symbol,
      ratioQty: String(leg.ratioQty),
      side: leg.side,
      positionIntent: leg.positionIntent,
    })),
  });
  return normalizeOrder(order as unknown as Raw);
}

export async function replaceOrder(
  orderId: string,
  input: ReplaceOrderInput,
): Promise<TradingOrder> {
  const order = await trading().orders.patchOrderByOrderId({
    orderId,
    patchOrderRequest: {
      qty: input.qty !== undefined ? String(input.qty) : undefined,
      limitPrice: input.limitPrice !== undefined ? String(input.limitPrice) : undefined,
      stopPrice: input.stopPrice !== undefined ? String(input.stopPrice) : undefined,
      trail: input.trail !== undefined ? String(input.trail) : undefined,
      timeInForce: input.timeInForce,
      clientOrderId: input.clientOrderId,
    },
  });
  return normalizeOrder(order as unknown as Raw);
}

export async function cancelOrder(orderId: string): Promise<void> {
  await trading().orders.deleteOrderByOrderID({ orderId });
}

export async function cancelAllOrders(): Promise<{ id: string; status: number }[]> {
  const result = await trading().orders.deleteAllOrders();
  return (result as unknown as Raw[]).map((r) => ({
    id: String(r.id ?? ""),
    status: Number(r.status ?? 0),
  }));
}
