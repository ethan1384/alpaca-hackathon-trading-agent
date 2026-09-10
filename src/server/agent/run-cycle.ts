import "server-only";

import { AGENT, etMinutes, etMinutesOf } from "@/config/agent";
import {
  COMPETITION,
  easternDate,
  getCompetitionPhase,
  isOpeningWindowOpen,
} from "@/config/competition";
import type {
  AgentCycleReport,
  AgentState,
  EntryReport,
  ManagedReport,
  ManagedSpread,
} from "@/domain/agent";
import type { DecisionDraft, DecisionRecord } from "@/domain/decision";
import type { StrategySignal } from "@/domain/strategy";
import type { TradingAccount, TradingOrder, TradingPosition } from "@/domain/trading";
import type { Bar, MarketClock } from "@/domain/types";
import { checkCompetitionAccount } from "@/server/alpaca/account-guard";
import type { getOptionSnapshots as defaultGetOptionSnapshots } from "@/server/alpaca/options";
import type { getHistoricalBars as defaultGetHistoricalBars } from "@/server/alpaca/rest";
import {
  cancelOrder as defaultCancelOrder,
  getOrder as defaultGetOrder,
  listPositions as defaultListPositions,
  placeOrder as defaultPlaceOrder,
} from "@/server/alpaca/trading";
import {
  buildEntryUserPrompt,
  decideJson,
  ENTRY_SYSTEM_PROMPT,
  type EntryDecision,
  EntryDecisionSchema,
  getLlmClient,
  type LlmClient,
} from "@/server/llm";
import {
  checkTrade,
  evaluateKillSwitch as defaultEvaluateKillSwitch,
  recordDecision as defaultRecordDecision,
  getKillSwitchState,
  readRecentDecisionsFromDisk,
  recentDecisions,
  serializeForReview,
} from "@/server/risk";
import {
  buildCreditSpreadCandidate,
  type CreditSpreadCandidate,
  type CreditSpreadDeps,
} from "@/server/strategies/credit-spread-strategy";
import { executeSignal as defaultExecuteSignal } from "@/server/strategies/execute";
import { hydrateAgentStateFromAlpaca } from "./hydrate";
import { buildCloseSignal, decideManage, markSpread } from "./monitor";
import { loadAgentState, mutateAgentState } from "./positions-store";

/**
 * One agent cycle: manage every open spread (mechanical exits in code, the LLM
 * only in the dead zone), then — inside the daily entry window — build a
 * mechanical candidate and put it to the LLM for a veto. `executeSignal` is the
 * only path to Alpaca. Safe to call repeatedly: at most one entry per ET day,
 * backed by a deterministic client order id.
 */

const ENTRY_IN_FLIGHT_MS = 90_000;

/** Net credit per spread from an mleg fill (Alpaca reports credits as negative). */
function filledCreditFromOrder(order: TradingOrder): number | undefined {
  if (order.filledAvgPrice == null || order.filledQty <= 0) {
    return undefined;
  }
  const credit = Math.abs(order.filledAvgPrice);
  return credit > 0 ? credit : undefined;
}

/** Recompute exit thresholds when the actual fill differs from the entry limit. */
function withFilledCredit(spread: ManagedSpread, filledCredit: number): ManagedSpread {
  return {
    ...spread,
    filledCredit,
    maxLossPerSpread: spread.width - filledCredit,
    targetBuyback: AGENT.targetProfitPct * filledCredit,
    stopBuyback: AGENT.stopMultiple * filledCredit,
  };
}

async function refreshSpreadFill(
  spread: ManagedSpread,
  getOrder: typeof defaultGetOrder,
): Promise<ManagedSpread> {
  if (spread.filledCredit != null || !spread.entryOrderId) {
    return spread;
  }
  const order = await getOrder(spread.entryOrderId).catch(() => null);
  const filled = order ? filledCreditFromOrder(order) : undefined;
  return filled != null ? withFilledCredit(spread, filled) : spread;
}

/** Older state files lack entrySpot — infer it from the 1-min tape at open time. */
async function backfillEntrySpot(
  spread: ManagedSpread,
  getHistoricalBars: typeof defaultGetHistoricalBars,
): Promise<ManagedSpread> {
  if (spread.entrySpot != null) {
    return spread;
  }
  const bars = await getHistoricalBars(spread.underlying, "1Min", 500).catch(() => [] as Bar[]);
  const opened = Date.parse(spread.openedAt);
  if (!Number.isFinite(opened) || bars.length === 0) {
    return spread;
  }
  let anchor: Bar | undefined;
  for (const bar of bars) {
    const t = Date.parse(bar.timestamp);
    if (Number.isNaN(t) || t > opened) {
      break;
    }
    anchor = bar;
  }
  return anchor ? { ...spread, entrySpot: anchor.close } : spread;
}

async function hydrateSpread(
  spread: ManagedSpread,
  deps: RunCycleDeps,
  getOrder: typeof defaultGetOrder,
): Promise<ManagedSpread> {
  let next = await refreshSpreadFill(spread, getOrder);
  if (deps.getHistoricalBars) {
    next = await backfillEntrySpot(next, deps.getHistoricalBars);
  }
  return next;
}

/**
 * How long a close order may sit unfilled before the agent gives up on the
 * limit, cancels it and re-closes at market.
 *
 * Without this a spread parked in `closing` was never looked at again: the
 * manage loop only walked `status === "open"`, so an unfilled limit left the
 * position live but unmanaged — no stop, no pre-snapshot forced close — while
 * simultaneously freeing a concurrency slot for a *new* spread.
 */
const CLOSE_ORDER_TIMEOUT_MS = 90_000;

/** Alpaca order states that are still working, i.e. could still fill. */
const LIVE_ORDER_STATUSES = new Set([
  "new",
  "accepted",
  "pending_new",
  "accepted_for_bidding",
  "partially_filled",
  "held",
  "replaced",
  "calculated",
  "done_for_day",
  "stopped",
  "suspended",
  "pending_replace",
]);

export interface RunCycleDeps extends CreditSpreadDeps {
  now?: Date;
  llm?: LlmClient;
  executeSignal?: typeof defaultExecuteSignal;
  placeOrder?: typeof defaultPlaceOrder;
  getOrder?: typeof defaultGetOrder;
  cancelOrder?: typeof defaultCancelOrder;
  evaluateKillSwitch?: typeof defaultEvaluateKillSwitch;
  getTradingAccount?: () => Promise<TradingAccount>;
  listPositions?: () => Promise<TradingPosition[]>;
  getOptionSnapshots?: typeof defaultGetOptionSnapshots;
  getHistoricalBars?: typeof defaultGetHistoricalBars;
  getMarketClock?: () => Promise<MarketClock>;
  recordDecision?: typeof defaultRecordDecision;
}

function notesForToday(state: AgentState, etDate: string): string {
  return state.notes
    .filter((n) => n.etDate === etDate)
    .map((n) => `[${n.topic}] ${n.text}`)
    .join("\n");
}

async function recentReview(): Promise<string> {
  const ring = recentDecisions(10);
  const records = ring.length > 0 ? ring : await readRecentDecisionsFromDisk(10);
  return serializeForReview(records);
}

function managedSpreadFrom(
  signal: StrategySignal,
  order: TradingOrder,
  candidate: CreditSpreadCandidate,
  etDate: string,
  now: Date,
): ManagedSpread {
  const { rationale } = candidate;
  const credit = signal.entryLimit ?? rationale.entryLimit;
  const filledCredit = filledCreditFromOrder(order);
  const base: ManagedSpread = {
    id: `agent-entry-${etDate}`,
    entryOrderId: order.id,
    underlying: signal.underlying,
    kind: "bull_put_spread",
    openedAt: now.toISOString(),
    entryEtDate: etDate,
    shortSymbol: signal.resolvedLegs?.[0].symbol ?? "",
    longSymbol: signal.resolvedLegs?.[1].symbol ?? "",
    shortStrike: rationale.shortStrike,
    longStrike: rationale.longStrike,
    width: rationale.width,
    contracts: signal.maxContracts,
    credit,
    entrySpot: rationale.spot,
    maxLossPerSpread: rationale.width - credit,
    expiration: rationale.expiration,
    targetBuyback: AGENT.targetProfitPct * credit,
    stopBuyback: AGENT.stopMultiple * credit,
    status: "open",
  };
  return filledCredit != null ? withFilledCredit(base, filledCredit) : base;
}

async function decideEntrySafe(
  llm: LlmClient,
  ctx: Parameters<typeof buildEntryUserPrompt>[0],
): Promise<{ value: EntryDecision; llm: DecisionRecord["llm"] }> {
  const userPrompt = buildEntryUserPrompt(ctx);
  try {
    const out = await decideJson(llm, {
      system: ENTRY_SYSTEM_PROMPT,
      user: userPrompt,
      schema: EntryDecisionSchema,
      temperature: AGENT.llmTemperature,
    });
    return {
      value: out.value,
      llm: {
        model: out.model,
        inputTokens: out.usage?.inputTokens,
        outputTokens: out.usage?.outputTokens,
        latencyMs: out.latencyMs,
        prompt: userPrompt,
        response: out.raw,
      },
    };
  } catch (error) {
    return {
      value: {
        act: false,
        confidence: 0,
        reason: `LLM unavailable (${error instanceof Error ? error.message : String(error)}) — skipping entry (fail-safe)`,
        concerns: [],
      },
      llm: { model: llm.model, prompt: userPrompt },
    };
  }
}

const isGuardrailError = (message: string): boolean =>
  /Risk gate:|Hackathon guardrail:|Competition account guard:/.test(message);

export async function runAgentCycle(deps: RunCycleDeps = {}): Promise<AgentCycleReport> {
  const now = deps.now ?? new Date();
  const llm = deps.llm ?? getLlmClient();
  const executeSignal = deps.executeSignal ?? defaultExecuteSignal;
  const listPositions = deps.listPositions ?? defaultListPositions;
  const recordDecision = deps.recordDecision ?? defaultRecordDecision;
  const basePlaceOrder = deps.placeOrder ?? defaultPlaceOrder;
  const getOrder = deps.getOrder ?? defaultGetOrder;
  const cancelOrder = deps.cancelOrder ?? defaultCancelOrder;
  const errors: string[] = [];
  let llmCallsRemaining = AGENT.llmDailyCallCap;

  // [O1] Read the drawdown every cycle. `isHalted()` is consulted by the risk
  // gate, but nothing was ever *setting* it outside the manual MCP tool — the
  // switch documented as enforced could not trip on its own during a run.
  // Reporting only: a failed read must not stop the manage pass.
  const killSwitch = await (deps.evaluateKillSwitch ?? defaultEvaluateKillSwitch)(
    deps.getTradingAccount ? { getTradingAccount: deps.getTradingAccount } : {},
  ).catch((error) => {
    errors.push(`kill switch: ${error instanceof Error ? error.message : String(error)}`);
    return getKillSwitchState();
  });
  if (killSwitch.tripped) {
    errors.push(`[O1] kill switch tripped: ${killSwitch.reason ?? "halted"}`);
  }

  const accountCheck = await checkCompetitionAccount({
    getTradingAccount: deps.getTradingAccount,
  }).catch((error) => {
    errors.push(`account guard: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });

  // The account guard *reports* here; `executeSignal` still enforces the
  // hard refusal via the hackathon + risk gates. If we could not even read the
  // account, keep going in a read-only fashion — the manage path never opens.
  const account = accountCheck?.account ?? null;
  const accountReport = {
    ok: accountCheck?.ok ?? false,
    number: account?.accountNumber,
    equity: account?.equity ?? 0,
    violations: accountCheck?.violations ?? ["account unreadable"],
  };

  let state = await loadAgentState();
  const hydrated = await hydrateAgentStateFromAlpaca(state, {
    listPositions: deps.listPositions,
    now,
  });
  if (
    hydrated.spreads.length !== state.spreads.length ||
    hydrated.enteredEtDates.length !== state.enteredEtDates.length
  ) {
    state = await mutateAgentState(() => hydrated);
  } else {
    state = hydrated;
  }
  const etDate = easternDate(now);

  // ─────────────── MANAGE ───────────────
  const managed: ManagedReport[] = [];
  const positions = await listPositions().catch((error) => {
    errors.push(`listPositions: ${error instanceof Error ? error.message : String(error)}`);
    return [] as TradingPosition[];
  });
  const heldSymbols = new Set(positions.map((p) => p.symbol));

  // `closing` is walked alongside `open`: a close order that never filled leaves
  // a live position, and it stays the agent's job to exit it.
  for (const spread of state.spreads.filter((s) => s.status === "open" || s.status === "closing")) {
    const gone = !heldSymbols.has(spread.shortSymbol) && !heldSymbols.has(spread.longSymbol);
    if (gone) {
      state = await mutateAgentState((s) => ({
        ...s,
        spreads: s.spreads.map((x) =>
          x.id === spread.id
            ? {
                ...x,
                status: "closed" as const,
                closedAt: now.toISOString(),
                closeReason: "reconciled/expired",
              }
            : x,
        ),
      }));
      await recordDecision(closeDraft(spread, "reconciled/expired", null, { status: "no-trade" }));
      managed.push({
        id: spread.id,
        shortSymbol: spread.shortSymbol,
        zone: "comfortable",
        action: "hold",
        buyback: null,
        pnlPctOfCredit: null,
        distanceToShortPct: null,
      });
      continue;
    }

    // Still holding the legs, but a close is already out there. Give the limit
    // `CLOSE_ORDER_TIMEOUT_MS` to work, then cancel it and re-arm the mechanical
    // exits — the retry below goes out at market.
    if (spread.status === "closing") {
      const pending = await closeStillWorking(spread, getOrder, now);
      if (pending) {
        managed.push({
          id: spread.id,
          shortSymbol: spread.shortSymbol,
          zone: "comfortable",
          action: "closing",
          buyback: null,
          pnlPctOfCredit: null,
          distanceToShortPct: null,
          orderId: spread.closeOrderId,
        });
        continue;
      }
      if (spread.closeOrderId) {
        await cancelOrder(spread.closeOrderId).catch(() => undefined);
      }
      state = await mutateAgentState((st) => ({
        ...st,
        spreads: st.spreads.map((x) =>
          x.id === spread.id ? { ...x, status: "open" as const, closeOrderId: undefined } : x,
        ),
      }));
      errors.push(
        `close ${spread.id}: order ${spread.closeOrderId ?? "(unknown)"} did not fill — re-closing at market`,
      );
    }

    const refreshed = await hydrateSpread(spread, deps, getOrder);
    if (refreshed !== spread) {
      state = await mutateAgentState((st) => ({
        ...st,
        spreads: st.spreads.map((x) => (x.id === spread.id ? refreshed : x)),
      }));
    }

    const mark = await markSpread(refreshed, deps, now);
    const mechanical =
      mark.zone === "deadline" ||
      mark.zone === "stop" ||
      mark.zone === "profit_target" ||
      mark.zone === "time_close";

    if (mechanical) {
      const result = await submitClose(
        spread,
        mark.zone,
        mark.buyback,
        executeSignal,
        deps,
        basePlaceOrder,
        // A retry of a close that would not fill, and the pre-snapshot deadline,
        // both go out at market: being flat beats the cushion.
        spread.status === "closing" || mark.zone === "deadline",
      );
      state = await applyCloseToState(state, spread, mark.zone, result);
      await recordDecision(
        closeDraft(
          spread,
          mark.zone,
          mark.buyback,
          result.order
            ? { status: "submitted", orderId: result.order.id }
            : { status: "error", error: result.error },
        ),
      );
      if (result.error) {
        errors.push(`close ${spread.id}: ${result.error}`);
      }
      managed.push({
        id: spread.id,
        shortSymbol: spread.shortSymbol,
        zone: mark.zone,
        action: result.order ? "closed" : "close-failed",
        buyback: mark.buyback,
        pnlPctOfCredit: mark.pnlPctOfCredit,
        distanceToShortPct: mark.distanceToShortPct,
        orderId: result.order?.id,
        error: result.error,
      });
      continue;
    }

    if (mark.zone === "dead_zone") {
      const priorNote = spread.lastLlm?.reason ?? "";
      const { decision, llm: llmMeta } = await decideManage(
        mark,
        llm,
        priorNote,
        llmCallsRemaining,
        now,
      );
      if (llmMeta) {
        llmCallsRemaining -= 1;
      }
      state = await mutateAgentState((s) => ({
        ...s,
        spreads: s.spreads.map((x) =>
          x.id === spread.id
            ? {
                ...x,
                lastLlm: {
                  at: now.toISOString(),
                  action: decision.action,
                  reason: decision.reason,
                  urgency: decision.urgency,
                },
              }
            : x,
        ),
      }));

      if (decision.action === "close") {
        const result = await submitClose(
          spread,
          "dead_zone/llm",
          mark.buyback,
          executeSignal,
          deps,
          basePlaceOrder,
          spread.status === "closing",
        );
        state = await applyCloseToState(state, spread, "dead_zone/llm", result);
        await recordDecision({
          ...closeDraft(
            spread,
            "dead_zone",
            mark.buyback,
            result.order
              ? { status: "submitted", orderId: result.order.id }
              : { status: "error", error: result.error },
          ),
          llm: llmMeta,
        });
        if (result.error) {
          errors.push(`close ${spread.id}: ${result.error}`);
        }
        managed.push({
          id: spread.id,
          shortSymbol: spread.shortSymbol,
          zone: "dead_zone",
          action: result.order ? "closed" : "close-failed",
          buyback: mark.buyback,
          pnlPctOfCredit: mark.pnlPctOfCredit,
          distanceToShortPct: mark.distanceToShortPct,
          llm: { action: decision.action, reason: decision.reason },
          orderId: result.order?.id,
          error: result.error,
        });
      } else {
        await recordDecision({
          strategy: AGENT.strategy,
          underlying: spread.underlying,
          trigger: { kind: "manage", detail: "dead_zone/hold" },
          chosen: null,
          rejected: [],
          guardrails: {},
          sizing: null,
          outcome: { status: "no-trade" },
          llm: llmMeta,
        });
        managed.push({
          id: spread.id,
          shortSymbol: spread.shortSymbol,
          zone: "dead_zone",
          action: "hold",
          buyback: mark.buyback,
          pnlPctOfCredit: mark.pnlPctOfCredit,
          distanceToShortPct: mark.distanceToShortPct,
          llm: { action: decision.action, reason: decision.reason },
        });
      }
      continue;
    }

    // comfortable — hold, no decision record
    managed.push({
      id: spread.id,
      shortSymbol: spread.shortSymbol,
      zone: mark.zone,
      action: "hold",
      buyback: mark.buyback,
      pnlPctOfCredit: mark.pnlPctOfCredit,
      distanceToShortPct: mark.distanceToShortPct,
    });
  }

  // ─────────────── ENTRY ───────────────
  const entry = await runEntry({
    now,
    etDate,
    llm,
    state,
    deps,
    executeSignal,
    basePlaceOrder,
    recordDecision,
    openManagedCount: state.spreads.filter((s) => s.status === "open").length,
    errors,
  });

  return {
    at: now.toISOString(),
    phase: getCompetitionPhase(now),
    entryWindowOpen: isOpeningWindowOpen(now),
    account: accountReport,
    entry,
    managed,
    errors,
  };
}

// ─────────────── entry sub-routine ───────────────

interface EntryArgs {
  now: Date;
  etDate: string;
  llm: LlmClient;
  state: AgentState;
  deps: RunCycleDeps;
  executeSignal: typeof defaultExecuteSignal;
  basePlaceOrder: typeof defaultPlaceOrder;
  recordDecision: typeof defaultRecordDecision;
  openManagedCount: number;
  errors: string[];
}

async function runEntry(a: EntryArgs): Promise<EntryReport> {
  const { now, etDate, state } = a;

  if (!isOpeningWindowOpen(now)) {
    return { evaluated: false, reason: "outside the scoring window" };
  }
  if (etDate >= COMPETITION.optionExpirationDeadline) {
    return { evaluated: false, reason: "too close to the equity snapshot" };
  }
  if (state.enteredEtDates.includes(etDate)) {
    return { evaluated: false, reason: "already entered today" };
  }
  const etNow = etMinutesOf(now);
  if (etNow < etMinutes(AGENT.entryWindowEt.start) || etNow > etMinutes(AGENT.entryWindowEt.end)) {
    return { evaluated: false, reason: "outside the daily entry window" };
  }
  if (a.openManagedCount >= AGENT.maxConcurrentSpreads) {
    return { evaluated: false, reason: "at the concurrent-spread cap" };
  }
  if (
    state.entryInFlightAt &&
    now.getTime() - Date.parse(state.entryInFlightAt) < ENTRY_IN_FLIGHT_MS
  ) {
    return { evaluated: false, reason: "an entry is already in flight" };
  }

  const outcome = await buildCreditSpreadCandidate(a.deps, a.openManagedCount, now);
  if (!outcome.ok) {
    const record = await a.recordDecision({
      strategy: AGENT.strategy,
      underlying: AGENT.underlying,
      trigger: { kind: "entry" },
      chosen: null,
      rejected: outcome.rejected,
      guardrails: {},
      sizing: null,
      outcome: { status: "no-trade", error: outcome.skip },
    });
    return { evaluated: true, acted: false, skipped: outcome.skip, decisionId: record.id };
  }

  const candidate = outcome.candidate;
  const legs = candidate.signal.resolvedLegs ?? [];

  const risk = await checkTrade(candidate.signal, legs, a.deps, now).catch(() => null);

  const { value: decision, llm: llmMeta } = await decideEntrySafe(a.llm, {
    todayEt: etDate,
    phase: getCompetitionPhase(now),
    hoursUntilSnapshot: (Date.parse(COMPETITION.equitySnapshot) - now.getTime()) / 3_600_000,
    optionDeadline: COMPETITION.optionExpirationDeadline,
    spot: candidate.rationale.spot,
    realisedVol: candidate.rationale.realisedVol,
    shortIv: candidate.rationale.shortIv,
    recentCloses: candidate.rationale.recentCloses,
    shortStrike: candidate.rationale.shortStrike,
    longStrike: candidate.rationale.longStrike,
    width: candidate.rationale.width,
    dte: candidate.rationale.dte,
    expiration: candidate.rationale.expiration,
    midCredit: candidate.rationale.midCredit,
    entryLimit: candidate.rationale.entryLimit,
    creditRatio: candidate.rationale.creditRatio,
    shortDelta: candidate.rationale.shortDelta,
    contracts: candidate.sizing.contracts,
    maxLossUsd: candidate.sizing.riskAmount,
    pctOfEquity: candidate.sizing.pctOfEquity,
    recentDecisions: await recentReview(),
    notes: notesForToday(state, etDate),
  });

  const sizing = {
    contracts: candidate.sizing.contracts,
    riskAmount: candidate.sizing.riskAmount,
    pctOfEquity: candidate.sizing.pctOfEquity,
  };

  if (!decision.act) {
    const record = await a.recordDecision({
      strategy: AGENT.strategy,
      underlying: AGENT.underlying,
      trigger: { kind: "entry" },
      chosen: null,
      rejected: [...candidate.rejected, { what: "mechanical candidate", why: decision.reason }],
      guardrails: risk?.checks ?? {},
      sizing,
      outcome: { status: "no-trade" },
      llm: llmMeta,
    });
    return {
      evaluated: true,
      acted: false,
      skipped: "llm veto",
      decisionId: record.id,
      llm: llmMeta,
    };
  }

  await mutateAgentState((s) => ({ ...s, entryInFlightAt: now.toISOString() }));

  const signal: StrategySignal = {
    ...candidate.signal,
    reason: decision.reason,
    confidence: decision.confidence,
  };
  const placeOrder: typeof defaultPlaceOrder = (input) =>
    a.basePlaceOrder({ ...input, clientOrderId: input.clientOrderId ?? `agent-entry-${etDate}` });

  try {
    // The agent writes its own richer [O5] record below; skip executeSignal's.
    const order = await a.executeSignal(signal, { ...a.deps, placeOrder, logExecution: false });
    await mutateAgentState((s) => ({
      ...s,
      entryInFlightAt: undefined,
      enteredEtDates: s.enteredEtDates.includes(etDate)
        ? s.enteredEtDates
        : [...s.enteredEtDates, etDate],
      spreads: [...s.spreads, managedSpreadFrom(signal, order, candidate, etDate, now)],
    }));
    const record = await a.recordDecision({
      strategy: AGENT.strategy,
      underlying: AGENT.underlying,
      trigger: { kind: "entry" },
      chosen: {
        kind: signal.kind,
        legs: legs.map((l) => l.symbol),
        contracts: signal.maxContracts,
        entryLimit: signal.entryLimit,
        reason: signal.reason,
        confidence: signal.confidence,
      },
      rejected: candidate.rejected,
      guardrails: risk?.checks ?? {},
      sizing,
      outcome: { status: "submitted", orderId: order.id },
      llm: llmMeta,
    });
    return { evaluated: true, acted: true, orderId: order.id, decisionId: record.id, llm: llmMeta };
  } catch (error) {
    await mutateAgentState((s) => ({ ...s, entryInFlightAt: undefined }));
    const message = error instanceof Error ? error.message : String(error);
    const status = isGuardrailError(message) ? ("blocked" as const) : ("error" as const);
    a.errors.push(`entry: ${message}`);
    const record = await a.recordDecision({
      strategy: AGENT.strategy,
      underlying: AGENT.underlying,
      trigger: { kind: "entry" },
      chosen: null,
      rejected: candidate.rejected,
      guardrails: risk?.checks ?? {},
      sizing,
      outcome: { status, error: message },
      llm: llmMeta,
    });
    return { evaluated: true, acted: false, error: message, decisionId: record.id, llm: llmMeta };
  }
}

// ─────────────── shared close helpers ───────────────

interface CloseResult {
  order?: TradingOrder;
  error?: string;
}

/**
 * Is the spread's close order still plausibly about to fill? True only while a
 * live order is younger than `CLOSE_ORDER_TIMEOUT_MS`. An unreadable order is
 * treated as not working, so a lookup failure re-closes rather than stranding
 * the position — the one thing worse than a duplicate close is no close.
 */
async function closeStillWorking(
  spread: ManagedSpread,
  getOrder: typeof defaultGetOrder,
  now: Date,
): Promise<boolean> {
  if (!spread.closeOrderId) {
    return false;
  }
  const order = await getOrder(spread.closeOrderId).catch(() => null);
  if (!order || !LIVE_ORDER_STATUSES.has(order.status)) {
    return false;
  }
  const placedAt = Date.parse(order.submittedAt ?? order.createdAt ?? spread.openedAt);
  return Number.isFinite(placedAt) && now.getTime() - placedAt < CLOSE_ORDER_TIMEOUT_MS;
}

async function submitClose(
  spread: ManagedSpread,
  reason: string,
  buyback: number | null,
  executeSignal: typeof defaultExecuteSignal,
  deps: RunCycleDeps,
  basePlaceOrder: typeof defaultPlaceOrder,
  urgent = false,
): Promise<CloseResult> {
  const signal = buildCloseSignal(spread, reason, buyback, urgent);
  const placeOrder: typeof defaultPlaceOrder = (input) =>
    basePlaceOrder({
      ...input,
      clientOrderId: input.clientOrderId ?? `agent-close-${spread.id}-${Date.now()}`,
    });
  try {
    // The manage path records its own close decision; skip executeSignal's.
    const order = await executeSignal(signal, { ...deps, placeOrder, logExecution: false });
    return { order };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function applyCloseToState(
  _state: AgentState,
  spread: ManagedSpread,
  reason: string,
  result: CloseResult,
): Promise<AgentState> {
  return mutateAgentState((s) => ({
    ...s,
    spreads: s.spreads.map((x) =>
      x.id === spread.id
        ? {
            ...x,
            status: result.order ? ("closing" as const) : x.status,
            closeReason: reason,
            closeOrderId: result.order?.id ?? x.closeOrderId,
            closedAt: result.order ? undefined : x.closedAt,
          }
        : x,
    ),
  }));
}

function closeDraft(
  spread: ManagedSpread,
  detail: string,
  buyback: number | null,
  outcome: DecisionDraft["outcome"],
): DecisionDraft {
  return {
    strategy: AGENT.strategy,
    underlying: spread.underlying,
    trigger: { kind: "manage", detail },
    chosen: {
      kind: spread.kind,
      legs: [spread.shortSymbol, spread.longSymbol],
      contracts: spread.contracts,
      entryLimit: buyback ?? undefined,
      reason: `close ${spread.id} (${detail})`,
    },
    rejected: [],
    guardrails: {},
    sizing: null,
    outcome,
  };
}
