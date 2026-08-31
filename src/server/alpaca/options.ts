import "server-only";

import { OPTIONS_FEED } from "@/config/constants";
import type { OptionChainType, OptionQuoteRow } from "@/domain/types";
import { normalizeSymbol, parseOptionSymbol } from "@/domain/types";
import { getAlpacaRestClient } from "./client";
import { normalizeOptionSnapshot, type RawOptionSnapshot } from "./normalize";

/** How far ahead to look when listing available expirations. */
const EXPIRATION_WINDOW_DAYS = 90;
/** Max OCC symbols per option-snapshot request. */
const SNAPSHOT_BATCH = 100;

type AlpacaRestClient = ReturnType<typeof getAlpacaRestClient>;

/** `Date` -> `YYYY-MM-DD` (UTC — Alpaca expirations are calendar dates at midnight UTC). */
function toIsoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().slice(0, 10);
}

export async function listOptionExpirations(underlying: string): Promise<string[]> {
  const client = getAlpacaRestClient();
  const root = normalizeSymbol(underlying);

  const now = new Date();
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() + EXPIRATION_WINDOW_DAYS);

  const contracts = await client.trading.collectOptionsContracts({
    underlyingSymbols: root,
    status: "active",
    expirationDateGte: now,
    expirationDateLte: end,
    limit: 10_000,
  } as never);

  const dates = new Set<string>();
  for (const contract of contracts) {
    if (contract.underlyingSymbol && normalizeSymbol(contract.underlyingSymbol) !== root) {
      continue;
    }
    dates.add(toIsoDate(contract.expirationDate));
  }
  return [...dates].sort();
}

export interface OptionChainParams {
  /** `YYYY-MM-DD`, required. */
  expiration: string;
  type?: OptionChainType;
  strikeGte?: number;
  strikeLte?: number;
  /** ATM +/- this fraction, applied against spot when explicit strike bounds are absent. */
  moneyness?: number;
}

export async function getOptionChain(
  underlying: string,
  params: OptionChainParams,
): Promise<{ spot?: number; rows: OptionQuoteRow[] }> {
  const client = getAlpacaRestClient();
  const root = normalizeSymbol(underlying);
  const day = new Date(`${params.expiration}T00:00:00Z`);

  const spot = await client.marketData.getLatestPrice(root).catch(() => undefined);

  let { strikeGte, strikeLte } = params;
  if (
    strikeGte == null &&
    strikeLte == null &&
    params.moneyness != null &&
    typeof spot === "number" &&
    spot > 0
  ) {
    strikeGte = spot * (1 - params.moneyness);
    strikeLte = spot * (1 + params.moneyness);
  }

  const type = params.type && params.type !== "all" ? params.type : undefined;

  const contracts = await client.trading.collectOptionsContracts({
    underlyingSymbols: root,
    status: "active",
    expirationDate: day,
    type,
    strikePriceGte: strikeGte,
    strikePriceLte: strikeLte,
    limit: 10_000,
  } as never);

  const bySymbol = new Map<string, OptionQuoteRow>();
  for (const contract of contracts) {
    const parsed = parseOptionSymbol(contract.symbol);
    if (!parsed || parsed.underlying !== root || parsed.expiration !== params.expiration) {
      continue;
    }
    bySymbol.set(contract.symbol, {
      ...parsed,
      openInterest: contract.openInterest != null ? Number(contract.openInterest) : undefined,
      // Provisional — the snapshot's latest trade price overrides this below.
      last: contract.closePrice != null ? Number(contract.closePrice) : undefined,
    });
  }

  await hydrateSnapshots(client, [...bySymbol.keys()], bySymbol);

  const rows = [...bySymbol.values()].sort(
    (a, b) => a.strike - b.strike || a.type.localeCompare(b.type),
  );
  return { spot, rows };
}

async function hydrateSnapshots(
  client: AlpacaRestClient,
  symbols: string[],
  bySymbol: Map<string, OptionQuoteRow>,
): Promise<void> {
  const snapshots = await fetchSnapshots(client, symbols);
  for (const [symbol, snap] of snapshots) {
    const row = bySymbol.get(symbol);
    if (!row) {
      continue;
    }
    row.bid = snap.bid;
    row.ask = snap.ask;
    if (snap.last != null) {
      row.last = snap.last;
    }
    row.mark = snap.mark;
    row.volume = snap.volume;
    row.impliedVolatility = snap.impliedVolatility;
    row.greeks = snap.greeks;
    row.updatedAt = snap.updatedAt;
  }
}

/** Batched option-snapshot fetch, keyed by OCC symbol. */
async function fetchSnapshots(
  client: AlpacaRestClient,
  symbols: string[],
): Promise<Map<string, ReturnType<typeof normalizeOptionSnapshot>>> {
  const out = new Map<string, ReturnType<typeof normalizeOptionSnapshot>>();
  for (let i = 0; i < symbols.length; i += SNAPSHOT_BATCH) {
    const batch = symbols.slice(i, i + SNAPSHOT_BATCH);
    const snapshots = await client.marketData
      .collectOptionSnapshotsBySymbol({ symbols: batch, feed: OPTIONS_FEED } as never)
      .catch(() => ({}) as Record<string, unknown>);
    for (const [symbol, raw] of Object.entries(snapshots)) {
      out.set(symbol, normalizeOptionSnapshot(raw as RawOptionSnapshot));
    }
  }
  return out;
}

/**
 * Latest quote + greeks for specific OCC contracts, without pulling a whole
 * chain. This is how the risk layer prices open positions: the account tells us
 * *what* we hold, only the snapshot tells us its delta and vega.
 *
 * Rows for symbols the feed did not return are omitted rather than filled with
 * zeros — the risk caps treat a missing greek as unknown, not as neutral.
 */
export async function getOptionSnapshots(symbols: string[]): Promise<Map<string, OptionQuoteRow>> {
  const client = getAlpacaRestClient();
  const wanted = symbols.map((s) => s.trim().toUpperCase()).filter(Boolean);
  const snapshots = await fetchSnapshots(client, wanted);

  const out = new Map<string, OptionQuoteRow>();
  for (const symbol of wanted) {
    const parsed = parseOptionSymbol(symbol);
    const snap = snapshots.get(symbol);
    if (!parsed || !snap) {
      continue;
    }
    out.set(symbol, { ...parsed, ...snap });
  }
  return out;
}
