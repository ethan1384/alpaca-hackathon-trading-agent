import "server-only";

import { AGENT, etMinutes, etMinutesOf } from "@/config/agent";
import { easternDate, msUntilSnapshot } from "@/config/competition";
import { quoteAnomalies } from "@/config/risk";
import { type ManagedSpread, type SpreadZone, spreadEntryCredit } from "@/domain/agent";
import type { DecisionRecord } from "@/domain/decision";
import type { StrategySignal } from "@/domain/strategy";
import { StrategySignalSchema } from "@/domain/strategy";
import type { OptionQuoteRow } from "@/domain/types";
import { getAlpacaRestClient } from "@/server/alpaca/client";
import { getOptionSnapshots as defaultGetOptionSnapshots } from "@/server/alpaca/options";
import type { LlmClient } from "@/server/llm";
import {
  buildManageUserPrompt,
  decideJson,
  MANAGE_SYSTEM_PROMPT,
  type ManageDecision,
  ManageDecisionSchema,
} from "@/server/llm";

/**
 * Marks one open agent spread against the live chain and decides which exit
 * "zone" it is in. The mechanical zones (deadline / stop / profit target /
 * time-close) are closed in code by the orchestrator; only `dead_zone` reaches
 * the LLM, and even then the mechanical stop is still armed for the next cycle.
 */

export interface MonitorDeps {
  getOptionSnapshots?: typeof defaultGetOptionSnapshots;
  getSpot?: (underlying: string) => Promise<number | undefined>;
}

export interface SpreadMark {
  spread: ManagedSpread;
  spot: number | null;
  shortMid: number | null;
  longMid: number | null;
  /** shortMid - longMid, clamped to [0, width]. Cost to buy the spread back. */
  buyback: number | null;
  /** credit - buyback, per spread, per share. Negative = losing. */
  openPnlPerSpread: number | null;
  pnlPctOfCredit: number | null;
  /** (spot - shortStrike) / spot. Positive = still OTM for a put credit spread. */
  distanceToShortPct: number | null;
  minutesToExpiry: number;
  minutesToSnapshot: number;
  priceable: boolean;
  zone: SpreadZone;
}

async function defaultGetSpot(underlying: string): Promise<number | undefined> {
  return getAlpacaRestClient()
    .marketData.getLatestPrice(underlying)
    .catch(() => undefined);
}

function legMid(row: OptionQuoteRow | undefined): number | null {
  if (!row) {
    return null;
  }
  if (row.bid != null && row.ask != null && row.bid > 0 && row.ask >= row.bid) {
    return (row.bid + row.ask) / 2;
  }
  return row.mark ?? null;
}

/**
 * Minutes from `now` to the option's expiration. Assumes the 16:00 ET close;
 * every competition expiration falls in EDT (16:00 ET = 20:00Z), which is where
 * this is used. Clamped at 0.
 */
export function minutesToExpiry(expiration: string, now: Date): number {
  const expiryMs = Date.parse(`${expiration}T20:00:00.000Z`);
  return Math.max(0, (expiryMs - now.getTime()) / 60_000);
}

export function classifyZone(m: Omit<SpreadMark, "zone">, now: Date): SpreadZone {
  const { spread } = m;

  if (m.minutesToSnapshot <= AGENT.forceCloseMinutesBeforeSnapshot) {
    return "deadline";
  }

  // Can't price the chain and we're near / through the short strike: fail flat.
  if (
    !m.priceable &&
    m.distanceToShortPct != null &&
    m.distanceToShortPct < AGENT.deadZoneProximityPct
  ) {
    return "stop";
  }

  if (m.buyback != null && m.buyback >= spread.stopBuyback) {
    return "stop";
  }
  if (m.buyback != null && m.buyback <= spread.targetBuyback) {
    return "profit_target";
  }

  const isExpirySession = easternDate(now) === spread.expiration;
  if (
    isExpirySession &&
    (etMinutesOf(now) >= etMinutes(AGENT.timeCloseEt) ||
      m.minutesToExpiry <= AGENT.timeCloseMinutes)
  ) {
    return "time_close";
  }

  const losing = m.pnlPctOfCredit != null && m.pnlPctOfCredit < 0;
  const nearStrike =
    m.distanceToShortPct != null && m.distanceToShortPct < AGENT.deadZoneProximityPct;
  const lowOnTime = m.minutesToExpiry < AGENT.deadZoneMinutes;
  if (losing && (nearStrike || lowOnTime)) {
    return "dead_zone";
  }

  return "comfortable";
}

export async function markSpread(
  spread: ManagedSpread,
  deps: MonitorDeps,
  now: Date,
): Promise<SpreadMark> {
  const getOptionSnapshots = deps.getOptionSnapshots ?? defaultGetOptionSnapshots;
  const getSpot = deps.getSpot ?? defaultGetSpot;

  const [snapshots, spotRaw] = await Promise.all([
    getOptionSnapshots([spread.shortSymbol, spread.longSymbol]).catch(
      () => new Map<string, OptionQuoteRow>(),
    ),
    getSpot(spread.underlying).catch(() => undefined),
  ]);
  const spot = spotRaw ?? null;

  const shortRow = snapshots.get(spread.shortSymbol);
  const longRow = snapshots.get(spread.longSymbol);
  const shortMid = legMid(shortRow);
  const longMid = legMid(longRow);

  const buyback =
    shortMid != null && longMid != null
      ? Math.min(spread.width, Math.max(0, shortMid - longMid))
      : null;
  const entryCredit = spreadEntryCredit(spread);
  const openPnlPerSpread = buyback != null ? entryCredit - buyback : null;
  const pnlPctOfCredit =
    openPnlPerSpread != null && entryCredit > 0 ? openPnlPerSpread / entryCredit : null;
  const distanceToShortPct = spot != null && spot > 0 ? (spot - spread.shortStrike) / spot : null;

  const priceable =
    shortRow != null &&
    longRow != null &&
    shortMid != null &&
    longMid != null &&
    quoteAnomalies(shortRow, now).length === 0 &&
    quoteAnomalies(longRow, now).length === 0;

  const base: Omit<SpreadMark, "zone"> = {
    spread,
    spot,
    shortMid,
    longMid,
    buyback,
    openPnlPerSpread,
    pnlPctOfCredit,
    distanceToShortPct,
    minutesToExpiry: minutesToExpiry(spread.expiration, now),
    minutesToSnapshot: msUntilSnapshot(now) / 60_000,
    priceable,
  };

  return { ...base, zone: classifyZone(base, now) };
}

/**
 * A closing `StrategySignal` for the spread. All legs `*_to_close`, sides
 * reversed — `isOpeningSignal` is false, so `executeSignal` skips the DTE clamp
 * and the risk gate, and `validateLegShape` short-circuits on the closing set.
 *
 * `urgent` sends a market order instead of a limit at `buyback + cushion`. Used
 * for the pre-snapshot forced close and for a retry of a close that did not
 * fill: past that point being flat is worth more than the cushion, and a limit
 * that sits unfilled through the snapshot is the one outcome the deadline rule
 * exists to prevent.
 */
export function buildCloseSignal(
  spread: ManagedSpread,
  reason: string,
  buyback: number | null,
  urgent = false,
): StrategySignal {
  const entryLimit =
    !urgent && buyback != null
      ? Math.round((buyback + AGENT.closeLimitCushion) * 100) / 100
      : undefined;

  return StrategySignalSchema.parse({
    strategy: AGENT.strategy,
    underlying: spread.underlying,
    bias: AGENT.bias,
    kind: spread.kind,
    selection: { minDte: 0, maxDte: 2, spreadWidth: spread.width },
    resolvedLegs: [
      { symbol: spread.shortSymbol, side: "buy", ratioQty: 1, positionIntent: "buy_to_close" },
      { symbol: spread.longSymbol, side: "sell", ratioQty: 1, positionIntent: "sell_to_close" },
    ],
    maxContracts: spread.contracts,
    ...(entryLimit != null ? { entryLimit } : { orderType: "market" }),
    confidence: 1,
    reason: `close ${spread.id}: ${reason}`,
    timestamp: new Date().toISOString(),
  });
}

export interface ManageDecisionResult {
  decision: ManageDecision;
  llm?: DecisionRecord["llm"];
}

const HOLD_ON_ERROR = (why: string): ManageDecision => ({
  action: "hold",
  reason: `${why} — holding; the mechanical stop is still armed`,
  urgency: "low",
});

/**
 * Ask the manage LLM whether to close a dead-zone spread early. Any failure
 * (unreachable, unparseable, budget exhausted) falls back to hold.
 */
export async function decideManage(
  mark: SpreadMark,
  llm: LlmClient,
  priorNote: string,
  callBudgetRemaining: number,
  now: Date = new Date(),
): Promise<ManageDecisionResult> {
  if (callBudgetRemaining <= 0) {
    return { decision: HOLD_ON_ERROR("LLM daily call cap reached") };
  }
  if (
    mark.buyback == null ||
    mark.spot == null ||
    mark.openPnlPerSpread == null ||
    mark.pnlPctOfCredit == null ||
    mark.distanceToShortPct == null
  ) {
    return { decision: HOLD_ON_ERROR("position not fully priceable") };
  }

  const userPrompt = buildManageUserPrompt({
    todayEt: easternDate(now),
    spot: mark.spot,
    shortStrike: mark.spread.shortStrike,
    distanceToShortPct: mark.distanceToShortPct,
    minutesToExpiry: mark.minutesToExpiry,
    minutesToSnapshot: mark.minutesToSnapshot,
    credit: spreadEntryCredit(mark.spread),
    buyback: mark.buyback,
    openPnlUsd: mark.openPnlPerSpread * 100 * mark.spread.contracts,
    pnlPctOfCredit: mark.pnlPctOfCredit,
    targetBuyback: mark.spread.targetBuyback,
    stopBuyback: mark.spread.stopBuyback,
    openedAt: mark.spread.openedAt,
    priorNote,
  });

  try {
    const out = await decideJson(llm, {
      system: MANAGE_SYSTEM_PROMPT,
      schema: ManageDecisionSchema,
      temperature: AGENT.llmTemperature,
      user: userPrompt,
    });
    return {
      decision: out.value,
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
      decision: HOLD_ON_ERROR(error instanceof Error ? error.message : String(error)),
      llm: { model: llm.model, prompt: userPrompt },
    };
  }
}
