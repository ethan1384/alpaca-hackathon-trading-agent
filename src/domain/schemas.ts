import { z } from "zod";

export const AlpacaRawBarSchema = z.object({
  T: z.literal("b"),
  S: z.string(),
  o: z.number(),
  h: z.number(),
  l: z.number(),
  c: z.number(),
  v: z.number(),
  t: z.string(),
  n: z.number().optional(),
  vw: z.number().optional(),
});

export const AlpacaRawQuoteSchema = z.object({
  T: z.literal("q"),
  S: z.string(),
  bp: z.number(),
  bs: z.number(),
  ap: z.number(),
  as: z.number(),
  t: z.string(),
});

export const AlpacaRawTradeSchema = z.object({
  T: z.literal("t"),
  S: z.string(),
  p: z.number(),
  s: z.number(),
  t: z.string(),
  c: z.array(z.string()).optional(),
});

export const SubscriptionRequestSchema = z.object({
  action: z.enum(["add", "remove"]),
  symbols: z.array(z.string().min(1)).min(1).max(10),
});

export const BarsQuerySchema = z.object({
  symbol: z.string().min(1),
  timeframe: z.enum(["1Min", "5Min", "15Min", "30Min", "1Hour", "1Day"]).optional(),
  limit: z.coerce.number().int().min(1).max(10000).optional(),
});

export const OptionContractsQuerySchema = z.object({
  underlying: z
    .string()
    .min(1)
    .max(6)
    .regex(/^[A-Za-z]+$/, "underlying must be letters only"),
  expiration: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "expiration must be YYYY-MM-DD")
    .optional(),
});

/** Query for the enriched option-chain branch of `/api/options/contracts`. */
export const OptionChainQuerySchema = z.object({
  underlying: z
    .string()
    .min(1)
    .max(6)
    .regex(/^[A-Za-z]+$/, "underlying must be letters only"),
  expiration: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expiration must be YYYY-MM-DD"),
  type: z.enum(["call", "put", "all"]).default("all"),
  strikeGte: z.coerce.number().positive().optional(),
  strikeLte: z.coerce.number().positive().optional(),
  /** ATM +/- this fraction; the server converts it to strike bounds using spot. */
  moneyness: z.coerce.number().positive().max(1).optional(),
});

export type OptionChainQuery = z.infer<typeof OptionChainQuerySchema>;

export type AlpacaRawBar = z.infer<typeof AlpacaRawBarSchema>;
export type AlpacaRawQuote = z.infer<typeof AlpacaRawQuoteSchema>;
export type AlpacaRawTrade = z.infer<typeof AlpacaRawTradeSchema>;
