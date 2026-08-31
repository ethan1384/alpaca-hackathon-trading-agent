import "server-only";

import { AGENT } from "@/config/agent";
import { easternDate } from "@/config/competition";
import type { AgentState, ManagedSpread } from "@/domain/agent";
import type { TradingPosition } from "@/domain/trading";
import { type OptionContract, parseOptionSymbol } from "@/domain/types";
import { listPositions as defaultListPositions } from "@/server/alpaca/trading";

/**
 * Rebuild agent working memory from Alpaca when blob/filesystem state was lost
 * (serverless cold start, redeploy) but the account still holds spread legs.
 *
 * Alpaca is the source of truth for *what* is held; credit/stop levels are
 * reconstructed from avg entry prices and `AGENT` calibration.
 */

interface ParsedLeg {
  position: TradingPosition;
  contract: OptionContract;
}

function parsePutLeg(position: TradingPosition): ParsedLeg | null {
  const contract = parseOptionSymbol(position.symbol);
  if (!contract || contract.type !== "put") {
    return null;
  }
  return { position, contract };
}

/**
 * Pair short/long put legs into bull put spreads for one underlying + expiration.
 * Exported for unit tests.
 */
export function pairBullPutSpreads(legs: TradingPosition[]): ManagedSpread[] {
  const parsed = legs.map(parsePutLeg).filter((x): x is ParsedLeg => x != null);
  const byKey = new Map<string, ParsedLeg[]>();
  for (const leg of parsed) {
    const key = `${leg.contract.underlying}:${leg.contract.expiration}`;
    const bucket = byKey.get(key) ?? [];
    bucket.push(leg);
    byKey.set(key, bucket);
  }

  const spreads: ManagedSpread[] = [];
  const used = new Set<string>();

  for (const group of byKey.values()) {
    const shorts = group.filter((l) => l.position.side === "short");
    const longs = group.filter((l) => l.position.side === "long");

    for (const shortLeg of shorts) {
      if (used.has(shortLeg.position.symbol)) {
        continue;
      }
      const wing = longs
        .filter(
          (l) =>
            !used.has(l.position.symbol) &&
            l.contract.strike < shortLeg.contract.strike &&
            l.position.qty === shortLeg.position.qty,
        )
        .sort((a, b) => b.contract.strike - a.contract.strike)[0];

      if (!wing) {
        continue;
      }

      const spread = buildManagedSpreadFromLegs(
        shortLeg.position,
        wing.position,
        shortLeg.contract,
        wing.contract,
      );
      if (spread) {
        spreads.push(spread);
        used.add(shortLeg.position.symbol);
        used.add(wing.position.symbol);
      }
    }
  }

  return spreads;
}

/** Build one `ManagedSpread` from matched Alpaca legs. */
export function buildManagedSpreadFromLegs(
  short: TradingPosition,
  long: TradingPosition,
  shortContract: OptionContract,
  longContract: OptionContract,
  now: Date = new Date(),
): ManagedSpread | null {
  if (short.side !== "short" || long.side !== "long") {
    return null;
  }
  if (shortContract.type !== "put" || longContract.type !== "put") {
    return null;
  }
  if (
    shortContract.underlying !== longContract.underlying ||
    shortContract.expiration !== longContract.expiration
  ) {
    return null;
  }
  if (shortContract.strike <= longContract.strike) {
    return null;
  }

  const contracts = Math.min(short.qty, long.qty);
  if (contracts <= 0) {
    return null;
  }

  const credit = short.avgEntryPrice - long.avgEntryPrice;
  if (!(credit > 0)) {
    return null;
  }

  const width = shortContract.strike - longContract.strike;
  if (!(width > 0)) {
    return null;
  }

  const etDate = easternDate(now);
  return {
    id: `agent-entry-${etDate}`,
    underlying: shortContract.underlying,
    kind: "bull_put_spread",
    openedAt: now.toISOString(),
    entryEtDate: etDate,
    shortSymbol: short.symbol,
    longSymbol: long.symbol,
    shortStrike: shortContract.strike,
    longStrike: longContract.strike,
    width,
    contracts,
    credit,
    maxLossPerSpread: width - credit,
    expiration: shortContract.expiration,
    targetBuyback: AGENT.targetProfitPct * credit,
    stopBuyback: AGENT.stopMultiple * credit,
    status: "open",
  };
}

/**
 * When no open/closing spread is in working memory, adopt any bull put spread
 * visible on the account so mechanical exits keep working.
 */
export async function hydrateAgentStateFromAlpaca(
  state: AgentState,
  deps: {
    listPositions?: () => Promise<TradingPosition[]>;
    now?: Date;
  } = {},
): Promise<AgentState> {
  const hasManaged = state.spreads.some((s) => s.status === "open" || s.status === "closing");
  if (hasManaged) {
    return state;
  }

  const listPositions = deps.listPositions ?? defaultListPositions;
  const now = deps.now ?? new Date();
  let positions: TradingPosition[];
  try {
    positions = await listPositions();
  } catch (error) {
    console.warn(
      "[agent-hydrate] could not list positions:",
      error instanceof Error ? error.message : String(error),
    );
    return state;
  }

  const adopted = pairBullPutSpreads(positions);
  if (adopted.length === 0) {
    return state;
  }

  console.warn(
    `[agent-hydrate] adopted ${adopted.length} spread(s) from Alpaca positions (state was empty)`,
  );

  const entered = new Set(state.enteredEtDates);
  for (const spread of adopted) {
    entered.add(spread.entryEtDate);
  }

  return {
    ...state,
    enteredEtDates: [...entered],
    spreads: [...state.spreads, ...adopted],
  };
}
