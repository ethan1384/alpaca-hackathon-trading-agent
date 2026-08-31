import type {
  Bar,
  MarketClock,
  OptionQuoteRow,
  OrderBook,
  Quote,
  StreamChannel,
  Timeframe,
  Trade,
} from "./types";

export type HubConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

export type StreamEvent =
  | { type: "bar"; data: Bar }
  | { type: "quote"; data: Quote }
  | { type: "trade"; data: Trade }
  | { type: "orderbook"; data: OrderBook }
  | {
      type: "status";
      data: { state: HubConnectionState; message?: string };
    }
  | {
      type: "subscription";
      data: { symbols: readonly string[]; channels: readonly StreamChannel[] };
    }
  | { type: "heartbeat"; data: { ts: number } };

export type SubscriptionAction = "add" | "remove";

export interface SubscriptionRequestBody {
  action: SubscriptionAction;
  symbols: string[];
}

export interface SubscriptionResponseBody {
  ok: true;
  subscribed: string[];
  channels: StreamChannel[];
}

export interface SubscriptionErrorBody {
  ok: false;
  error: string;
}

export interface BarsQueryParams {
  symbol: string;
  timeframe?: Timeframe;
  limit?: number;
}

export interface BarsResponseBody {
  symbol: string;
  timeframe: Timeframe;
  assetClass: "stock" | "crypto" | "option";
  bars: Bar[];
}

export interface OptionExpirationsResponseBody {
  underlying: string;
  expirations: string[];
}

export interface OptionChainResponseBody {
  underlying: string;
  expiration: string;
  /** Latest underlying spot price, when available. */
  spot?: number;
  rows: OptionQuoteRow[];
}

export interface ClockResponseBody extends MarketClock {
  paper: boolean;
  feed: "test" | "iex" | "sip";
}
