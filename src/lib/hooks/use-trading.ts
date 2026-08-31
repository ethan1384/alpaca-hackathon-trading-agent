"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ClosePositionInput, PlaceOrderInput, ReplaceOrderInput } from "@/domain/trading";
import {
  cancelAllOrdersRequest,
  cancelOrderRequest,
  closeAllPositionsRequest,
  closePositionRequest,
  fetchAccount,
  fetchOrders,
  fetchPositions,
  placeOrderRequest,
  replaceOrderRequest,
} from "@/lib/api/trading";

const ACCOUNT_KEY = ["trading", "account"] as const;
const POSITIONS_KEY = ["trading", "positions"] as const;
const ORDERS_KEY = ["trading", "orders"] as const;

export function useAccount() {
  return useQuery({ queryKey: ACCOUNT_KEY, queryFn: fetchAccount, refetchInterval: 15_000 });
}

export function usePositions() {
  return useQuery({ queryKey: POSITIONS_KEY, queryFn: fetchPositions, refetchInterval: 10_000 });
}

export function useOrders(status: "open" | "closed" | "all" = "open") {
  return useQuery({
    queryKey: [...ORDERS_KEY, status],
    queryFn: () => fetchOrders(status),
    refetchInterval: 8_000,
  });
}

/** Invalidate everything that an order/position action can affect. */
function useRefreshTrading() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ACCOUNT_KEY });
    qc.invalidateQueries({ queryKey: POSITIONS_KEY });
    qc.invalidateQueries({ queryKey: ORDERS_KEY });
  };
}

export function usePlaceOrder() {
  const refresh = useRefreshTrading();
  return useMutation({
    mutationFn: (input: PlaceOrderInput) => placeOrderRequest(input),
    onSuccess: refresh,
  });
}

export function useReplaceOrder() {
  const refresh = useRefreshTrading();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ReplaceOrderInput }) =>
      replaceOrderRequest(id, input),
    onSuccess: refresh,
  });
}

export function useCancelOrder() {
  const refresh = useRefreshTrading();
  return useMutation({ mutationFn: (id: string) => cancelOrderRequest(id), onSuccess: refresh });
}

export function useCancelAllOrders() {
  const refresh = useRefreshTrading();
  return useMutation({ mutationFn: cancelAllOrdersRequest, onSuccess: refresh });
}

export function useClosePosition() {
  const refresh = useRefreshTrading();
  return useMutation({
    mutationFn: ({ symbol, input }: { symbol: string; input?: ClosePositionInput }) =>
      closePositionRequest(symbol, input),
    onSuccess: refresh,
  });
}

export function useCloseAllPositions() {
  const refresh = useRefreshTrading();
  return useMutation({ mutationFn: closeAllPositionsRequest, onSuccess: refresh });
}
