import type { CreditGateRejection, SpreadSide } from "@/domain/backtest-credit";
import { creditSpreadValue, type OptionType, optionDelta, strikeForDelta } from "./black-scholes";
import {
  type EntryHandlerContext,
  type EntryOpportunity,
  MAX_CREDIT_RATIO,
  type OpenSpread,
} from "./credit-spread-engine";

export interface SpreadCandidate {
  side: SpreadSide;
  type: OptionType;
  shortStrike: number;
  longStrike: number;
  iv: number;
  shortDelta: number;
  netDeltaPerContract: number;
  credit: number;
  maxLoss: number;
  perContract: number;
  valueWithFriction: number;
  constructionReject?: string;
}

export type GateFailure = {
  ok: false;
  control: string;
  observed: string;
  threshold: string;
};

export type GateSuccess = { ok: true; contracts: number };

export type GateResult = GateSuccess | GateFailure;

export function buildSpreadCandidate(
  side: SpreadSide,
  opportunity: EntryOpportunity,
  params: EntryHandlerContext["params"],
): SpreadCandidate {
  const { baseIv, spot, t, width } = opportunity;
  const type: OptionType = side;
  const iv = side === "put" ? baseIv * (1 + params.putIvPremium) : baseIv;

  const shortStrike = strikeForDelta(
    type,
    spot,
    params.targetDelta,
    t,
    params.riskFreeRate,
    iv,
    params.strikeStep,
  );
  const longStrike = side === "put" ? shortStrike - width : shortStrike + width;

  if (longStrike <= 0) {
    return emptyCandidate(side, type, shortStrike, longStrike, iv, "long_strike_out_of_range");
  }

  const value = creditSpreadValue(type, spot, shortStrike, longStrike, t, params.riskFreeRate, iv);
  const credit = value - 2 * params.frictionPerLeg;
  if (credit < params.minCredit) {
    return emptyCandidate(side, type, shortStrike, longStrike, iv, "credit_below_min");
  }
  if (credit / width > MAX_CREDIT_RATIO) {
    return emptyCandidate(side, type, shortStrike, longStrike, iv, "credit_ratio_implausible");
  }

  const maxLoss = width - credit;
  if (maxLoss <= 0) {
    return emptyCandidate(side, type, shortStrike, longStrike, iv, "credit_ratio_implausible");
  }

  const shortLegDelta = optionDelta(type, spot, shortStrike, t, params.riskFreeRate, iv);
  const longLegDelta = optionDelta(type, spot, longStrike, t, params.riskFreeRate, iv);

  return {
    side,
    type,
    shortStrike,
    longStrike,
    iv,
    shortDelta: Math.abs(shortLegDelta),
    netDeltaPerContract: (-shortLegDelta + longLegDelta) * 100,
    credit,
    maxLoss,
    perContract: maxLoss * 100,
    valueWithFriction: value + 2 * params.frictionPerLeg,
  };
}

function emptyCandidate(
  side: SpreadSide,
  type: OptionType,
  shortStrike: number,
  longStrike: number,
  iv: number,
  reason: string,
): SpreadCandidate {
  return {
    side,
    type,
    shortStrike,
    longStrike,
    iv,
    shortDelta: 0,
    netDeltaPerContract: 0,
    credit: 0,
    maxLoss: 0,
    perContract: 0,
    valueWithFriction: 0,
    constructionReject: reason,
  };
}

export function resolveStructure(
  put: SpreadCandidate | null,
  call: SpreadCandidate | null,
  sidesMode: "both" | "put" | "call",
): { candidates: SpreadCandidate[]; structure: "condor" | "put" | "call" } | null {
  const putOk = put != null && put.constructionReject == null;
  const callOk = call != null && call.constructionReject == null;

  if (sidesMode === "put") {
    return putOk ? { candidates: [put], structure: "put" } : null;
  }
  if (sidesMode === "call") {
    return callOk ? { candidates: [call], structure: "call" } : null;
  }

  if (putOk && callOk) {
    return { candidates: [put, call], structure: "condor" };
  }
  if (putOk) {
    return { candidates: [put], structure: "put" };
  }
  if (callOk) {
    return { candidates: [call], structure: "call" };
  }
  return null;
}

export function evaluateCreditEntryGate(
  candidates: SpreadCandidate[],
  ctx: Pick<EntryHandlerContext, "book" | "params" | "opportunity">,
): GateResult {
  const { book, params, opportunity } = ctx;
  const { open, bpUsed, dayRisk, netDeltaShares, equity } = book;
  const { spot } = opportunity;

  if (open.length + candidates.length > params.maxConcurrentSpreads) {
    return {
      ok: false,
      control: "max_concurrent_spreads",
      observed: `${open.length + candidates.length} spreads`,
      threshold: `${params.maxConcurrentSpreads} max`,
    };
  }

  const bpCeiling = Math.min(params.buyingPowerCap, params.buyingPowerPctCap * equity);
  const bpRoom = bpCeiling - bpUsed;
  const riskRoom = params.dailyRiskCapPct * equity - dayRisk;
  const totalPerContract = candidates.reduce((a, c) => a + c.perContract, 0);

  let contracts = Math.min(
    ...candidates.map((c) => Math.floor((equity * params.riskPerSidePct) / c.perContract)),
  );
  contracts = Math.min(contracts, Math.floor(bpRoom / totalPerContract));
  contracts = Math.min(contracts, Math.floor(riskRoom / totalPerContract));

  if (contracts < 1) {
    if (bpRoom < totalPerContract) {
      return {
        ok: false,
        control: "buying_power_cap",
        observed: `$${bpUsed.toFixed(0)} used + $${totalPerContract.toFixed(0)} proposed`,
        threshold: `$${bpCeiling.toFixed(0)} cap`,
      };
    }
    if (riskRoom < totalPerContract) {
      return {
        ok: false,
        control: "daily_risk_cap",
        observed: `$${dayRisk.toFixed(0)} day risk + $${totalPerContract.toFixed(0)} proposed`,
        threshold: `$${(params.dailyRiskCapPct * equity).toFixed(0)} (${(params.dailyRiskCapPct * 100).toFixed(0)}% equity)`,
      };
    }
    return {
      ok: false,
      control: "size_below_one_contract",
      observed: `0 contracts at $${totalPerContract.toFixed(0)} per structure`,
      threshold: "≥1 contract",
    };
  }

  const projectedDelta =
    netDeltaShares + contracts * candidates.reduce((a, c) => a + c.netDeltaPerContract, 0);
  const deltaNotional = Math.abs(projectedDelta) * spot;
  const deltaCap = params.maxNetDeltaPctEquity * equity;
  if (deltaNotional > deltaCap) {
    return {
      ok: false,
      control: "net_delta_cap",
      observed: `$${deltaNotional.toFixed(0)} net delta`,
      threshold: `$${deltaCap.toFixed(0)} (${(params.maxNetDeltaPctEquity * 100).toFixed(0)}% equity)`,
    };
  }

  return { ok: true, contracts };
}

export function commitSpreads(
  ctx: EntryHandlerContext,
  candidates: SpreadCandidate[],
  contracts: number,
): void {
  const { book, opportunity, sessionsWithEntry } = ctx;
  const { open } = book;
  const { underlying, date, bar, expiration, expirySessionIndex, dte, minutes, spot, width } =
    opportunity;

  let projected = book.netDeltaShares;
  for (const cand of candidates) {
    const position: OpenSpread = {
      id: `${underlying}-${date}-${cand.side}-${cand.shortStrike}`,
      underlying,
      date,
      side: cand.side,
      type: cand.type,
      entryTimestamp: bar.timestamp,
      entrySpot: spot,
      expiration,
      expirySessionIndex,
      dte,
      shortStrike: cand.shortStrike,
      longStrike: cand.longStrike,
      width,
      iv: cand.iv,
      shortDelta: cand.shortDelta,
      netDeltaShares: cand.netDeltaPerContract,
      credit: cand.credit,
      maxLoss: cand.maxLoss,
      contracts,
      riskAmount: cand.perContract * contracts,
      entryMinutesToExpiry: minutes,
      lastCost: cand.valueWithFriction,
      minCost: cand.valueWithFriction,
      maxCost: cand.valueWithFriction,
    };

    open.push(position);
    book.bpUsed += position.riskAmount;
    book.dayRisk += position.riskAmount;
    projected += cand.netDeltaPerContract * contracts;
    sessionsWithEntry.add(`${underlying}:${date}`);
  }
  book.netDeltaShares = projected;
}

export function logGateRejection(
  ctx: EntryHandlerContext,
  structure: "condor" | "put" | "call",
  candidates: SpreadCandidate[],
  failure: GateFailure,
): void {
  const { opportunity, rejectionLog } = ctx;
  const entry: CreditGateRejection = {
    timestamp: opportunity.bar.timestamp,
    underlying: opportunity.underlying,
    date: opportunity.date,
    structure,
    control: failure.control,
    observed: failure.observed,
    threshold: failure.threshold,
    sides: candidates.map((c) => c.side),
  };
  rejectionLog.push(entry);
  ctx.reject(failure.control);
}

export function processEntryAggregate(ctx: EntryHandlerContext): void {
  const { params, opportunity, reject } = ctx;
  const { sides } = opportunity;

  const putCand = sides.includes("put") ? buildSpreadCandidate("put", opportunity, params) : null;
  const callCand = sides.includes("call")
    ? buildSpreadCandidate("call", opportunity, params)
    : null;

  if (putCand?.constructionReject) {
    reject(putCand.constructionReject);
  }
  if (callCand?.constructionReject) {
    reject(callCand.constructionReject);
  }

  const resolved = resolveStructure(putCand, callCand, params.sides);
  if (!resolved) {
    return;
  }

  const gate = evaluateCreditEntryGate(resolved.candidates, ctx);
  if (!gate.ok) {
    logGateRejection(ctx, resolved.structure, resolved.candidates, gate);
    return;
  }

  commitSpreads(ctx, resolved.candidates, gate.contracts);
}

/** Per-leg gate — pre-fix behaviour; each side is sized and committed independently. */
export function processEntryPerLeg(ctx: EntryHandlerContext): void {
  const { book, params, opportunity, reject } = ctx;
  const {
    sides,
    underlying,
    date,
    bar,
    expiration,
    expirySessionIndex,
    dte,
    minutes,
    spot,
    width,
  } = opportunity;
  const { open } = book;

  for (const side of sides) {
    const cand = buildSpreadCandidate(side, opportunity, params);
    if (cand.constructionReject) {
      reject(cand.constructionReject);
      continue;
    }

    if (open.length >= params.maxConcurrentSpreads) {
      reject("max_concurrent_spreads");
      continue;
    }

    const bpCeiling = Math.min(params.buyingPowerCap, params.buyingPowerPctCap * book.equity);
    const bpRoom = bpCeiling - book.bpUsed;
    const riskRoom = params.dailyRiskCapPct * book.equity - book.dayRisk;

    let contracts = Math.floor((book.equity * params.riskPerSidePct) / cand.perContract);
    contracts = Math.min(contracts, Math.floor(bpRoom / cand.perContract));
    contracts = Math.min(contracts, Math.floor(riskRoom / cand.perContract));
    if (contracts < 1) {
      reject(
        bpRoom < cand.perContract
          ? "buying_power_cap"
          : riskRoom < cand.perContract
            ? "daily_risk_cap"
            : "size_below_one_contract",
      );
      continue;
    }

    const projected = book.netDeltaShares + cand.netDeltaPerContract * contracts;
    if (Math.abs(projected) * spot > params.maxNetDeltaPctEquity * book.equity) {
      reject("net_delta_cap");
      continue;
    }

    const position: OpenSpread = {
      id: `${underlying}-${date}-${side}-${cand.shortStrike}`,
      underlying,
      date,
      side,
      type: cand.type,
      entryTimestamp: bar.timestamp,
      entrySpot: spot,
      expiration,
      expirySessionIndex,
      dte,
      shortStrike: cand.shortStrike,
      longStrike: cand.longStrike,
      width,
      iv: cand.iv,
      shortDelta: cand.shortDelta,
      netDeltaShares: cand.netDeltaPerContract,
      credit: cand.credit,
      maxLoss: cand.maxLoss,
      contracts,
      riskAmount: cand.perContract * contracts,
      entryMinutesToExpiry: minutes,
      lastCost: cand.valueWithFriction,
      minCost: cand.valueWithFriction,
      maxCost: cand.valueWithFriction,
    };

    open.push(position);
    book.bpUsed += position.riskAmount;
    book.dayRisk += position.riskAmount;
    book.netDeltaShares = projected;
    ctx.sessionsWithEntry.add(`${underlying}:${date}`);
  }
}
