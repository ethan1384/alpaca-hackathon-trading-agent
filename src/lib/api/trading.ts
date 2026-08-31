import type {
  ClosePositionInput,
  PlaceOrderInput,
  ReplaceOrderInput,
  TradingAccount,
  TradingOrder,
  TradingPosition,
} from "@/domain/trading";

async function json<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(data.error ?? `Request failed (${response.status})`);
  }
  return data;
}

export function fetchAccount(): Promise<TradingAccount> {
  return fetch("/api/account").then((r) => json<TradingAccount>(r));
}

export function fetchPositions(): Promise<TradingPosition[]> {
  return fetch("/api/positions")
    .then((r) => json<{ positions: TradingPosition[] }>(r))
    .then((d) => d.positions);
}

export function fetchOrders(status: "open" | "closed" | "all" = "open"): Promise<TradingOrder[]> {
  return fetch(`/api/orders?status=${status}&nested=true`)
    .then((r) => json<{ orders: TradingOrder[] }>(r))
    .then((d) => d.orders);
}

export function placeOrderRequest(input: PlaceOrderInput): Promise<TradingOrder> {
  return fetch("/api/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json<TradingOrder>(r));
}

export function replaceOrderRequest(id: string, input: ReplaceOrderInput): Promise<TradingOrder> {
  return fetch(`/api/orders/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json<TradingOrder>(r));
}

export function cancelOrderRequest(id: string): Promise<void> {
  return fetch(`/api/orders/${id}`, { method: "DELETE" }).then((r) => json<void>(r));
}

export function cancelAllOrdersRequest(): Promise<void> {
  return fetch("/api/orders", { method: "DELETE" }).then((r) => json<void>(r));
}

export function closePositionRequest(
  symbol: string,
  input: ClosePositionInput = {},
): Promise<TradingOrder> {
  return fetch(`/api/positions/${encodeURIComponent(symbol)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json<TradingOrder>(r));
}

export function closeAllPositionsRequest(): Promise<void> {
  return fetch("/api/positions?cancelOrders=true", { method: "DELETE" }).then((r) => json<void>(r));
}
