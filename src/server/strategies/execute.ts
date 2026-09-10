import "server-only";

import type { DecisionDraft } from "@/domain/decision";
import { isCreditSpreadKind, type StrategySignal, StrategySignalSchema } from "@/domain/strategy";
import { type PlaceOrderInput, PlaceOrderSchema, type TradingOrder } from "@/domain/trading";
import { placeOrder as defaultPlaceOrder } from "@/server/alpaca/trading";
import {
  assertTradeAllowed,
  recordDecision as defaultRecordDecision,
  type RiskGateDeps,
} from "@/server/risk";
import { applyCompetitionDteWindow, assertSignalAllowed, isOpeningSignal } from "./guardrails";
import {
  resolveContracts as defaultResolveContracts,
  type SelectContractDeps,
} from "./select-contract";

export interface ExecuteSignalDeps extends Partial<SelectContractDeps>, RiskGateDeps {
  placeOrder?: (input: PlaceOrderInput) => Promise<TradingOrder>;
  resolveContracts?: typeof defaultResolveContracts;
  /**
   * Write an [O5] decision-log record for this execution. Default `true` — every
   * caller that is not the LLM agent (MCP `place_option_strategy`, a manual
   * signal) gets traced here. The agent passes `false` because it writes its own
   * far richer record (rejected alternatives, sizing, the LLM prompt/response).
   */
  logExecution?: boolean;
  recordDecision?: typeof defaultRecordDecision;
}

function executionDraft(
  signal: StrategySignal,
  legs: { symbol: string }[],
  outcome: DecisionDraft["outcome"],
): DecisionDraft {
  const opening = isOpeningSignal(signal);
  return {
    strategy: signal.strategy,
    underlying: signal.underlying,
    trigger: { kind: "execute", detail: opening ? "open" : "close" },
    chosen: {
      kind: signal.kind,
      legs: legs.map((l) => l.symbol),
      contracts: signal.maxContracts,
      entryLimit: signal.entryLimit,
      reason: signal.reason,
      confidence: signal.confidence,
    },
    rejected: [],
    guardrails: {},
    sizing: null,
    outcome,
  };
}

const isGuardrailError = (message: string): boolean =>
  /Risk gate:|Hackathon guardrail:|Competition account guard:/.test(message);

/**
 * Map a resolved options signal to a `PlaceOrderInput`. Single leg -> a plain
 * option order (`positionIntent` carried through). Multiple legs -> an `mleg`
 * order (order class derived by `deriveOrderClass`). Throws if the signal has no
 * resolved legs or a leg is not an option — `PlaceOrderSchema` is the guard.
 */
export function signalToOrder(signal: StrategySignal): PlaceOrderInput {
  const legs = signal.resolvedLegs ?? [];
  if (legs.length === 0) {
    throw new Error(`signal "${signal.strategy}" has no resolved option legs`);
  }

  // `entryLimit` is a positive magnitude. A credit structure receives premium on
  // open (Alpaca wants a negative mleg limit — confirmed: for `mleg`, positive =
  // net debit, negative = net credit) and pays a debit to buy it back on close
  // (positive). Debit structures are always positive.
  const closing = legs.every(
    (l) => l.positionIntent === "buy_to_close" || l.positionIntent === "sell_to_close",
  );
  const netCredit = isCreditSpreadKind(signal.kind) && !closing;

  const type = signal.orderType ?? (signal.entryLimit != null ? "limit" : "market");
  const limitPrice =
    type === "market" || signal.entryLimit == null
      ? undefined
      : netCredit
        ? -signal.entryLimit
        : signal.entryLimit;
  const common = {
    type,
    qty: signal.maxContracts,
    limitPrice,
    timeInForce: "day" as const,
  };

  if (legs.length === 1) {
    const [only] = legs;
    return PlaceOrderSchema.parse({
      ...common,
      symbol: only.symbol,
      side: only.side,
      positionIntent: only.positionIntent,
    });
  }

  return PlaceOrderSchema.parse({
    ...common,
    legs: legs.map((leg) => ({
      symbol: leg.symbol,
      side: leg.side,
      ratioQty: leg.ratioQty,
      positionIntent: leg.positionIntent,
    })),
  });
}

/**
 * Resolve (if needed) then submit a strategy signal as a real Alpaca order.
 * This is the single execution entry point for the strategy / agent layer, and
 * therefore where both guardrail layers run: legacy event compatibility checks
 * (`./guardrails`, docs/05) and the account risk caps (`@/server/risk`, docs/06).
 */
export async function executeSignal(
  signal: StrategySignal,
  deps: ExecuteSignalDeps = {},
): Promise<TradingOrder> {
  const resolve = deps.resolveContracts ?? defaultResolveContracts;
  const place = deps.placeOrder ?? defaultPlaceOrder;
  const logExecution = deps.logExecution ?? true;
  const recordDecision = deps.recordDecision ?? defaultRecordDecision;

  // Best-effort [O5] trace for every non-agent execution. Never lets a log
  // failure — or the logging itself — mask the trading outcome.
  const trace = async (
    trySignal: StrategySignal,
    legs: { symbol: string }[],
    outcome: DecisionDraft["outcome"],
  ): Promise<void> => {
    if (!logExecution) return;
    try {
      await recordDecision(executionDraft(trySignal, legs, outcome));
    } catch {
      // recordDecision is already best-effort; this guard is belt-and-braces.
    }
  };

  try {
    // Competition rules first, so a breach costs nothing (no chain fetch, no
    // order). See docs/05-legacy-competition.md.
    assertSignalAllowed(signal);

    const legs = signal.resolvedLegs?.length
      ? signal.resolvedLegs
      : await resolve(applyCompetitionDteWindow(signal), deps);
    if (legs.length === 0) {
      throw new Error(`no option contracts resolved for ${signal.underlying} (${signal.kind})`);
    }

    const validated = StrategySignalSchema.parse({ ...signal, resolvedLegs: legs });
    // Re-check with concrete contracts: only now are the leg expirations known.
    assertSignalAllowed(validated);

    // Then the risk layer: the hackathon may allow this trade while the account
    // cannot afford it. Opening trades only — risk must always be reducible, so a
    // closing order is never gated. See docs/06-options-parameters.md.
    if (isOpeningSignal(validated)) {
      await assertTradeAllowed(validated, legs, deps);
    }

    const order = await place(signalToOrder(validated));
    await trace(validated, legs, { status: "submitted", orderId: order.id });
    return order;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await trace(signal, signal.resolvedLegs ?? [], {
      status: isGuardrailError(message) ? "blocked" : "error",
      error: message,
    });
    throw error;
  }
}
