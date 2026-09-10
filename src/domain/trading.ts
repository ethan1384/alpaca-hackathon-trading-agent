import { z } from "zod";
import { isOptionSymbol, parseOptionSymbol } from "./types";

// --- Enums (mirrors of the Alpaca SDK string unions, kept dependency-free) ----

export const ORDER_SIDES = ["buy", "sell"] as const;
export type OrderSide = (typeof ORDER_SIDES)[number];

export const ORDER_TYPES = ["market", "limit", "stop", "stop_limit", "trailing_stop"] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const TIME_IN_FORCE = ["day", "gtc", "opg", "cls", "ioc", "fok"] as const;
export type TimeInForce = (typeof TIME_IN_FORCE)[number];

export const ORDER_CLASSES = ["simple", "bracket", "oco", "oto", "mleg"] as const;
export type OrderClass = (typeof ORDER_CLASSES)[number];

export const POSITION_INTENTS = [
  "buy_to_open",
  "buy_to_close",
  "sell_to_open",
  "sell_to_close",
] as const;
export type PositionIntent = (typeof POSITION_INTENTS)[number];

// --- Normalized read models -------------------------------------------------

/** A normalized Alpaca order. All monetary fields are numbers (SDK returns strings). */
export interface TradingOrder {
  id: string;
  clientOrderId?: string;
  symbol: string;
  assetClass?: string;
  side?: OrderSide;
  type: OrderType;
  orderClass?: OrderClass;
  timeInForce: TimeInForce;
  status: string;
  qty?: number;
  notional?: number;
  filledQty: number;
  filledAvgPrice?: number;
  limitPrice?: number;
  stopPrice?: number;
  trailPrice?: number;
  trailPercent?: number;
  extendedHours?: boolean;
  positionIntent?: PositionIntent;
  createdAt?: string;
  submittedAt?: string;
  filledAt?: string;
  canceledAt?: string;
  updatedAt?: string;
  /** Bracket/OCO/OTO child orders, when the query was nested. */
  legs?: TradingOrder[];
}

/** A normalized open position. */
export interface TradingPosition {
  symbol: string;
  assetClass?: string;
  side: "long" | "short";
  qty: number;
  qtyAvailable?: number;
  avgEntryPrice: number;
  currentPrice?: number;
  lastdayPrice?: number;
  marketValue?: number;
  costBasis?: number;
  unrealizedPl?: number;
  unrealizedPlpc?: number;
  unrealizedIntradayPl?: number;
  unrealizedIntradayPlpc?: number;
  changeToday?: number;
}

/** A normalized trading account snapshot. */
export interface TradingAccount {
  id: string;
  accountNumber?: string;
  status: string;
  currency: string;
  cash: number;
  equity: number;
  lastEquity?: number;
  buyingPower: number;
  regtBuyingPower?: number;
  daytradingBuyingPower?: number;
  nonMarginableBuyingPower?: number;
  optionsBuyingPower?: number;
  portfolioValue?: number;
  longMarketValue?: number;
  shortMarketValue?: number;
  initialMargin?: number;
  maintenanceMargin?: number;
  daytradeCount?: number;
  patternDayTrader?: boolean;
  tradingBlocked?: boolean;
  transfersBlocked?: boolean;
  accountBlocked?: boolean;
  shortingEnabled?: boolean;
  optionsTradingLevel?: number;
  optionsApprovedLevel?: number;
}

// --- Order placement input --------------------------------------------------

const positiveNumber = z.number().positive();

const takeProfitSchema = z.object({
  limitPrice: positiveNumber,
});

const stopLossSchema = z.object({
  stopPrice: positiveNumber,
  /** Present -> the stop-loss leg is a stop-limit instead of stop-market. */
  limitPrice: positiveNumber.optional(),
});

/**
 * One leg of a multi-leg (`mleg`) option order. `symbol` must be an OCC option
 * contract — Alpaca only accepts `mleg` for options. `ratioQty` is the leg's
 * proportion of the top-level `qty` (usually 1).
 */
export const OrderLegSchema = z.object({
  symbol: z
    .string()
    .min(1)
    .transform((s) => s.trim().toUpperCase()),
  side: z.enum(ORDER_SIDES),
  ratioQty: z.number().int().positive().default(1),
  positionIntent: z.enum(POSITION_INTENTS),
});
export type OrderLeg = z.infer<typeof OrderLegSchema>;

/**
 * One schema for every order shape Alpaca accepts. `type` drives which price
 * fields are required; `takeProfit`/`stopLoss` promote a `simple` order to a
 * `bracket` (both), `oto` (one), or `oco` (one, no entry price) — the server
 * derives `orderClass` unless it is set explicitly.
 */
export const PlaceOrderSchema = z
  .object({
    /** Stock / crypto / OCC option symbol. Optional (and ignored) for `mleg` — use `legs`. */
    symbol: z
      .string()
      .min(1)
      .transform((s) => s.trim().toUpperCase())
      .optional(),
    /** Required for single-symbol orders; omitted for `mleg` (each leg carries its own side). */
    side: z.enum(ORDER_SIDES).optional(),
    type: z.enum(ORDER_TYPES).default("market"),
    timeInForce: z.enum(TIME_IN_FORCE).default("day"),
    orderClass: z.enum(ORDER_CLASSES).optional(),
    qty: positiveNumber.optional(),
    notional: positiveNumber.optional(),
    /**
     * Positive for a single-symbol order and a net-debit `mleg`. May be negative
     * for a net-**credit** `mleg` (Alpaca convention: negative limit = credit
     * received). The sign is enforced in the refinement below.
     */
    limitPrice: z.number().optional(),
    stopPrice: positiveNumber.optional(),
    trailPrice: positiveNumber.optional(),
    trailPercent: positiveNumber.optional(),
    extendedHours: z.boolean().optional(),
    clientOrderId: z.string().min(1).max(128).optional(),
    positionIntent: z.enum(POSITION_INTENTS).optional(),
    takeProfit: takeProfitSchema.optional(),
    stopLoss: stopLossSchema.optional(),
    /** 2–4 option legs -> a multi-leg (`mleg`) order. All legs must be OCC symbols on one underlying. */
    legs: z.array(OrderLegSchema).min(2).max(4).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.legs && v.legs.length > 0) {
      if (!v.qty) {
        ctx.addIssue({ code: "custom", message: "Multi-leg orders require qty", path: ["qty"] });
      }
      if (v.notional) {
        ctx.addIssue({
          code: "custom",
          message: "Multi-leg orders cannot use notional",
          path: ["notional"],
        });
      }
      if (v.type !== "market" && v.type !== "limit") {
        ctx.addIssue({
          code: "custom",
          message: "Multi-leg orders must be market or limit",
          path: ["type"],
        });
      }
      if (v.type === "limit" && v.limitPrice === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "Multi-leg limit orders require limitPrice",
          path: ["limitPrice"],
        });
      }
      const underlyings = new Set<string>();
      for (const leg of v.legs) {
        const contract = parseOptionSymbol(leg.symbol);
        if (!contract) {
          ctx.addIssue({
            code: "custom",
            message: `Leg ${leg.symbol} is not an option (OCC) symbol`,
            path: ["legs"],
          });
        } else {
          underlyings.add(contract.underlying);
        }
      }
      if (underlyings.size > 1) {
        ctx.addIssue({
          code: "custom",
          message: "All legs must share one underlying",
          path: ["legs"],
        });
      }
      return;
    }
    if (!v.symbol) {
      ctx.addIssue({ code: "custom", message: "symbol is required", path: ["symbol"] });
    }
    if (!v.side) {
      ctx.addIssue({ code: "custom", message: "side is required", path: ["side"] });
    }
    if (v.limitPrice !== undefined && v.limitPrice <= 0) {
      ctx.addIssue({
        code: "custom",
        message: "limitPrice must be positive for a single-symbol order",
        path: ["limitPrice"],
      });
    }
    if (!v.qty && !v.notional) {
      ctx.addIssue({ code: "custom", message: "Provide either qty or notional", path: ["qty"] });
    }
    if (v.qty && v.notional) {
      ctx.addIssue({
        code: "custom",
        message: "qty and notional are mutually exclusive",
        path: ["notional"],
      });
    }
    if (v.notional && (v.takeProfit || v.stopLoss)) {
      ctx.addIssue({
        code: "custom",
        message: "Bracket / OCO / OTO orders require qty, not notional",
        path: ["notional"],
      });
    }
    if ((v.type === "limit" || v.type === "stop_limit") && v.limitPrice === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `${v.type} orders require limitPrice`,
        path: ["limitPrice"],
      });
    }
    if ((v.type === "stop" || v.type === "stop_limit") && v.stopPrice === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `${v.type} orders require stopPrice`,
        path: ["stopPrice"],
      });
    }
    // [R10] Alpaca supports market / limit / stop / stop_limit on options.
    // Trailing stops are equities-only — fail here rather than on an Alpaca
    // 4xx mid-session. See docs/05-legacy-competition.md.
    if (v.type === "trailing_stop" && v.symbol && isOptionSymbol(v.symbol)) {
      ctx.addIssue({
        code: "custom",
        message:
          "trailing_stop is not supported for option contracts (equities only) — use market, limit, stop or stop_limit",
        path: ["type"],
      });
    }
    if (v.type === "trailing_stop" && v.trailPrice === undefined && v.trailPercent === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "trailing_stop orders require trailPrice or trailPercent",
        path: ["trailPrice"],
      });
    }
    if (v.trailPrice !== undefined && v.trailPercent !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "trailPrice and trailPercent are mutually exclusive",
        path: ["trailPercent"],
      });
    }
  });

export type PlaceOrderInput = z.infer<typeof PlaceOrderSchema>;

/** Derive the order class Alpaca expects from the take-profit / stop-loss legs. */
export function deriveOrderClass(input: PlaceOrderInput): OrderClass {
  if (input.orderClass) {
    return input.orderClass;
  }
  if (input.legs && input.legs.length > 0) {
    return "mleg";
  }
  const legs = Number(Boolean(input.takeProfit)) + Number(Boolean(input.stopLoss));
  if (legs === 2) {
    return "bracket";
  }
  if (legs === 1) {
    return "oto";
  }
  return "simple";
}

// --- Order replacement input ------------------------------------------------

export const ReplaceOrderSchema = z
  .object({
    qty: positiveNumber.optional(),
    /** May be negative when re-pricing a net-credit `mleg` — see `PlaceOrderSchema`. */
    limitPrice: z.number().optional(),
    stopPrice: positiveNumber.optional(),
    trail: positiveNumber.optional(),
    timeInForce: z.enum(TIME_IN_FORCE).optional(),
    clientOrderId: z.string().min(1).max(128).optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "Provide at least one field to change",
  });

export type ReplaceOrderInput = z.infer<typeof ReplaceOrderSchema>;

// --- List orders query -----------------------------------------------------

export const ListOrdersQuerySchema = z.object({
  status: z.enum(["open", "closed", "all"]).default("open"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  direction: z.enum(["asc", "desc"]).optional(),
  nested: z.coerce.boolean().optional(),
  symbols: z
    .string()
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean),
    )
    .optional(),
  side: z.enum(ORDER_SIDES).optional(),
  after: z.string().optional(),
  until: z.string().optional(),
});

export type ListOrdersQuery = z.infer<typeof ListOrdersQuerySchema>;

// --- Close position input -------------------------------------------------

export const ClosePositionSchema = z
  .object({
    qty: positiveNumber.optional(),
    percentage: z.number().positive().max(100).optional(),
  })
  .refine((v) => !(v.qty && v.percentage), {
    message: "qty and percentage are mutually exclusive",
  });

export type ClosePositionInput = z.infer<typeof ClosePositionSchema>;
