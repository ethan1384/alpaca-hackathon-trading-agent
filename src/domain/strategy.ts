import { z } from "zod";
import { ORDER_SIDES, POSITION_INTENTS } from "./trading";
import { formatOptionLabel, isOptionSymbol, parseOptionSymbol } from "./types";

/**
 * The strategy signal is the single output contract of every trading strategy.
 *
 * Hackathon rule — **all strategies must incorporate options trading**. That
 * rule is enforced here, at the type boundary: a `StrategySignal` describes a
 * directional thesis on an underlying that resolves to one or more **option**
 * contracts (OCC symbols). `StrategySignalSchema` rejects any signal whose legs
 * are equities or crypto. Strategies never emit "buy 100 shares of AAPL".
 *
 * Flow: `Strategy.evaluate()` returns a signal with `selection` criteria (target
 * delta / DTE window / liquidity floor). `src/server/strategies/select-contract`
 * turns that into concrete `resolvedLegs`. `src/server/strategies/execute` then
 * maps the resolved signal to a `PlaceOrderInput` and submits it.
 */

// --- Enums -----------------------------------------------------------------

export const DIRECTIONAL_BIASES = ["bullish", "bearish", "neutral"] as const;
export type DirectionalBias = (typeof DIRECTIONAL_BIASES)[number];

/**
 * Option structures a strategy may express. Single-leg + defined-risk verticals
 * (debit and credit) + the long straddle.
 */
export const OPTION_STRATEGY_KINDS = [
  "long_call",
  "long_put",
  "bull_call_spread",
  "bear_put_spread",
  "long_straddle",
  // Net-credit verticals: the short leg is nearer the money, the long leg is the
  // wing. `entryLimit` on these is the credit to *receive* (still a positive
  // magnitude — the Alpaca mleg sign is applied in `signalToOrder`).
  "bull_put_spread",
  "bear_call_spread",
] as const;
export type OptionStrategyKind = (typeof OPTION_STRATEGY_KINDS)[number];

/** The subset that collects a net credit on open. */
export const CREDIT_STRATEGY_KINDS = ["bull_put_spread", "bear_call_spread"] as const;

export function isCreditSpreadKind(kind: OptionStrategyKind): boolean {
  return kind === "bull_put_spread" || kind === "bear_call_spread";
}

/** Legs expected once a strategy of this kind has been resolved to contracts. */
export function expectedLegCount(kind: OptionStrategyKind): 1 | 2 {
  return kind === "long_call" || kind === "long_put" ? 1 : 2;
}

/** The call/put side an option-chain query should use for this kind. */
export function chainTypeForKind(kind: OptionStrategyKind): "call" | "put" | "all" {
  switch (kind) {
    case "long_call":
    case "bull_call_spread":
    case "bear_call_spread":
      return "call";
    case "long_put":
    case "bear_put_spread":
    case "bull_put_spread":
      return "put";
    default:
      return "all";
  }
}

// --- Contract selection criteria -----------------------------------------

/**
 * How to pick the concrete contract(s) from a live chain. Supplied by the
 * strategy; consumed by `select-contract`. Provide `targetDelta` (preferred) or
 * `moneyness`; omit both for at-the-money.
 */
export const ContractSelectionSchema = z
  .object({
    /** Absolute delta of the long leg, e.g. 0.40. Preferred selector. */
    targetDelta: z.number().gt(0).lt(1).optional(),
    /** Signed strike distance from spot as a fraction, e.g. -0.02. Fallback selector. */
    moneyness: z.number().min(-1).max(1).optional(),
    /** Earliest acceptable days-to-expiration. */
    minDte: z.number().int().min(0).default(7),
    /** Latest acceptable days-to-expiration. */
    maxDte: z.number().int().min(1).default(45),
    /** Reject contracts below this open interest. */
    minOpenInterest: z.number().int().min(0).default(0),
    /** Reject contracts whose bid/ask spread exceeds this fraction of mark. */
    maxSpreadPct: z.number().gt(0).max(5).default(0.25),
    /** Distance between long and short strike for a vertical spread (price points). */
    spreadWidth: z.number().gt(0).optional(),
  })
  .refine((v) => v.minDte <= v.maxDte, {
    message: "minDte must be <= maxDte",
    path: ["minDte"],
  });
export type ContractSelection = z.infer<typeof ContractSelectionSchema>;

// --- Resolved legs -------------------------------------------------------

/** One resolved option leg. `symbol` is always an OCC contract. */
export const OptionOrderLegSchema = z.object({
  symbol: z
    .string()
    .transform((s) => s.trim().toUpperCase())
    .refine(isOptionSymbol, "strategy legs must be option (OCC) contracts, not equities or crypto"),
  side: z.enum(ORDER_SIDES),
  ratioQty: z.number().int().positive().default(1),
  positionIntent: z.enum(POSITION_INTENTS),
});
export type OptionOrderLeg = z.infer<typeof OptionOrderLegSchema>;

// --- Signal ------------------------------------------------------------

export const StrategySignalSchema = z
  .object({
    /** Name of the emitting strategy. */
    strategy: z.string().min(1),
    /** Underlying analysed, e.g. `SPY`. */
    underlying: z
      .string()
      .min(1)
      .transform((s) => s.trim().toUpperCase()),
    bias: z.enum(DIRECTIONAL_BIASES),
    kind: z.enum(OPTION_STRATEGY_KINDS),
    selection: ContractSelectionSchema,
    /** Filled by `select-contract` before execution. */
    resolvedLegs: z.array(OptionOrderLegSchema).min(1).max(4).optional(),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1),
    /** Order quantity — number of contracts (single-leg) or spreads (multi-leg). */
    maxContracts: z.number().int().positive().default(1),
    /**
     * Net price limit per contract/spread, as a **positive magnitude**. For the
     * debit kinds it is the maximum debit to pay; for the credit kinds
     * (`bull_put_spread` / `bear_call_spread`) it is the minimum credit to
     * receive. `signalToOrder` applies the Alpaca mleg sign. Omit for a market
     * order — or set `orderType: "market"` to keep this value for risk sizing
     * while still submitting at market.
     */
    entryLimit: z.number().positive().optional(),
    /**
     * Force the order type. Default: `"limit"` when `entryLimit` is set, else
     * `"market"`. Set `"market"` explicitly to submit at market while keeping
     * `entryLimit` populated so the risk gate can still price the position.
     */
    orderType: z.enum(["market", "limit"]).optional(),
    /** Underlying level that invalidates the thesis (for the agent's exit logic). */
    underlyingStop: z.number().positive().optional(),
    underlyingTarget: z.number().positive().optional(),
    timestamp: z.string().min(1),
  })
  .superRefine((v, ctx) => {
    // `selection.spreadWidth` is optional — select-contract falls back to the
    // local strike increment when a vertical omits it.
    if (v.resolvedLegs) {
      validateLegShape(v.kind, v.underlying, v.resolvedLegs, ctx);
    }
  });
export type StrategySignal = z.infer<typeof StrategySignalSchema>;

function validateLegShape(
  kind: OptionStrategyKind,
  underlying: string,
  legs: OptionOrderLeg[],
  ctx: z.RefinementCtx,
): void {
  const issue = (message: string) =>
    ctx.addIssue({ code: "custom", message, path: ["resolvedLegs"] });

  const parsed = legs.map((leg) => ({ leg, contract: parseOptionSymbol(leg.symbol) }));
  for (const { leg, contract } of parsed) {
    if (!contract) {
      issue(`leg ${leg.symbol} is not a valid OCC option symbol`);
      return;
    }
    if (contract.underlying !== underlying) {
      issue(`leg ${leg.symbol} is not on underlying ${underlying}`);
      return;
    }
  }

  const want = expectedLegCount(kind);
  if (legs.length !== want) {
    issue(`${kind} needs exactly ${want} leg(s), got ${legs.length}`);
    return;
  }

  // A closing order reverses every leg side vs the opening structure. The
  // structural "buy the lower strike / sell the higher strike" assertion only
  // describes an opening spread; `PlaceOrderSchema` and Alpaca still validate the
  // order itself. So once every leg is `*_to_close`, stop here.
  const allClosing = legs.every(
    (l) => l.positionIntent === "buy_to_close" || l.positionIntent === "sell_to_close",
  );
  if (allClosing) {
    return;
  }

  const contracts = parsed.map(
    (p) => p.contract as NonNullable<(typeof parsed)[number]["contract"]>,
  );

  switch (kind) {
    case "long_call":
    case "long_put": {
      const type = kind === "long_call" ? "call" : "put";
      if (contracts[0].type !== type || legs[0].side !== "buy") {
        issue(`${kind} must be a single long ${type}`);
      }
      break;
    }
    case "bull_call_spread": {
      const [long, short] = orderByStrike(legs, contracts, "asc");
      if (long.contract.type !== "call" || short.contract.type !== "call") {
        issue("bull_call_spread legs must both be calls");
      } else if (long.leg.side !== "buy" || short.leg.side !== "sell") {
        issue("bull_call_spread must buy the lower strike and sell the higher strike");
      }
      break;
    }
    case "bear_put_spread": {
      const [long, short] = orderByStrike(legs, contracts, "desc");
      if (long.contract.type !== "put" || short.contract.type !== "put") {
        issue("bear_put_spread legs must both be puts");
      } else if (long.leg.side !== "buy" || short.leg.side !== "sell") {
        issue("bear_put_spread must buy the higher strike and sell the lower strike");
      }
      break;
    }
    case "bull_put_spread": {
      // Net credit: sell the higher-strike put, buy the lower-strike put (wing).
      const [lower, higher] = orderByStrike(legs, contracts, "asc");
      if (lower.contract.type !== "put" || higher.contract.type !== "put") {
        issue("bull_put_spread legs must both be puts");
      } else if (higher.leg.side !== "sell" || lower.leg.side !== "buy") {
        issue("bull_put_spread must sell the higher strike and buy the lower strike");
      }
      break;
    }
    case "bear_call_spread": {
      // Net credit: sell the lower-strike call, buy the higher-strike call (wing).
      const [lower, higher] = orderByStrike(legs, contracts, "asc");
      if (lower.contract.type !== "call" || higher.contract.type !== "call") {
        issue("bear_call_spread legs must both be calls");
      } else if (lower.leg.side !== "sell" || higher.leg.side !== "buy") {
        issue("bear_call_spread must sell the lower strike and buy the higher strike");
      }
      break;
    }
    case "long_straddle": {
      const types = contracts
        .map((c) => c.type)
        .sort()
        .join(",");
      if (types !== "call,put") {
        issue("long_straddle needs one call and one put");
      } else if (contracts[0].strike !== contracts[1].strike) {
        issue("long_straddle legs must share a strike");
      } else if (legs.some((l) => l.side !== "buy")) {
        issue("long_straddle legs must both be long");
      }
      break;
    }
  }
}

function orderByStrike(
  legs: OptionOrderLeg[],
  contracts: { strike: number; type: "call" | "put" }[],
  direction: "asc" | "desc",
): { leg: OptionOrderLeg; contract: { strike: number; type: "call" | "put" } }[] {
  const paired = legs.map((leg, i) => ({ leg, contract: contracts[i] }));
  paired.sort((a, b) =>
    direction === "asc"
      ? a.contract.strike - b.contract.strike
      : b.contract.strike - a.contract.strike,
  );
  return paired;
}

/** One-line human/log description of a signal. */
export function describeSignal(signal: StrategySignal): string {
  const legs = signal.resolvedLegs
    ?.map((leg) => {
      const contract = parseOptionSymbol(leg.symbol);
      return `${leg.side} ${contract ? formatOptionLabel(contract) : leg.symbol}`;
    })
    .join(" / ");
  const head = `[${signal.strategy}] ${signal.kind} on ${signal.underlying} · ${signal.bias} · conf ${signal.confidence.toFixed(2)}`;
  return legs ? `${head} — ${legs}` : head;
}
