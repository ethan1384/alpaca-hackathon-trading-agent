import type { Bar } from "@/domain/types";

/**
 * Layer 1 of the backtest: the opening-range breakout signal, computed on the
 * underlying's 1-minute bars and nothing else.
 *
 * Pure and options-free on purpose. If the trigger does not reach one range
 * extension often enough to clear the break-even hit rate the vertical needs,
 * no amount of structure modelling saves it — so this layer must be able to
 * answer on its own.
 */

/** 09:30 ET, in minutes from ET midnight. */
export const MARKET_OPEN_ET = 9 * 60 + 30;
/** 16:00 ET. */
export const MARKET_CLOSE_ET = 16 * 60;

const ET_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Session date (`YYYY-MM-DD`) and minutes-from-midnight, both in US/Eastern. */
export function toEastern(timestamp: string): { date: string; minutes: number } {
  const parts = ET_FORMAT.formatToParts(new Date(timestamp));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  // `hour12: false` renders midnight as 24 in some ICU versions.
  const hour = Number(get("hour")) % 24;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hour * 60 + Number(get("minute")),
  };
}

/** `"HH:MM"` → minutes from midnight. */
export function parseEtTime(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export interface SessionBar extends Bar {
  /** Minutes from ET midnight. */
  etMinutes: number;
  /** Session-cumulative VWAP up to and including this bar. */
  sessionVwap: number;
}

export interface Session {
  date: string;
  bars: SessionBar[];
  /** Close of the previous session in the series, when there is one. */
  priorClose: number | null;
}

function typicalPrice(bar: Bar): number {
  return bar.vwap ?? (bar.high + bar.low + bar.close) / 3;
}

/**
 * Group bars into regular-hours sessions, ordered by date, each carrying a
 * running VWAP and the prior session's close. Bars outside 09:30–16:00 ET are
 * dropped: the opening range and the flatten ladder are both defined against
 * the regular session.
 */
export function groupSessions(bars: Bar[]): Session[] {
  const byDate = new Map<string, SessionBar[]>();

  for (const bar of bars) {
    const { date, minutes } = toEastern(bar.timestamp);
    if (minutes < MARKET_OPEN_ET || minutes >= MARKET_CLOSE_ET) {
      continue;
    }
    const list = byDate.get(date) ?? [];
    list.push({ ...bar, etMinutes: minutes, sessionVwap: 0 });
    byDate.set(date, list);
  }

  const dates = [...byDate.keys()].sort();
  const sessions: Session[] = [];
  let priorClose: number | null = null;

  for (const date of dates) {
    const sessionBars = (byDate.get(date) ?? []).sort((a, b) => a.etMinutes - b.etMinutes);
    let cumulativeValue = 0;
    let cumulativeVolume = 0;
    for (const bar of sessionBars) {
      cumulativeValue += typicalPrice(bar) * bar.volume;
      cumulativeVolume += bar.volume;
      bar.sessionVwap = cumulativeVolume > 0 ? cumulativeValue / cumulativeVolume : bar.close;
    }
    sessions.push({ date, bars: sessionBars, priorClose });
    priorClose = sessionBars.at(-1)?.close ?? priorClose;
  }

  return sessions;
}

export interface OpeningRange {
  high: number;
  low: number;
  /** `high - low`. Drives both the vertical's width and its target. */
  size: number;
  meanVolume: number;
  /** First minute at which a breakout may be taken. */
  endEtMinutes: number;
}

export function openingRange(session: Session, rangeMinutes: number): OpeningRange | null {
  const end = MARKET_OPEN_ET + rangeMinutes;
  const rangeBars = session.bars.filter((b) => b.etMinutes < end);
  if (rangeBars.length === 0) {
    return null;
  }
  const high = Math.max(...rangeBars.map((b) => b.high));
  const low = Math.min(...rangeBars.map((b) => b.low));
  const meanVolume = rangeBars.reduce((a, b) => a + b.volume, 0) / rangeBars.length;
  return { high, low, size: high - low, meanVolume, endEtMinutes: end };
}

export interface TriggerFilters {
  breakoutBufferPct: number;
  volumeMultiple: number;
  requireVwapAlign: boolean;
  requirePriorCloseAlign: boolean;
  /** No trigger is reported at or after this minute (ET). */
  cutoffEtMinutes: number;
}

export interface Trigger {
  timestamp: string;
  etMinutes: number;
  /** Bar close that fired the trigger — the backtest's entry reference. */
  spot: number;
  direction: "long" | "short";
}

/**
 * Every bar that satisfies the breakout conditions, in time order. Sequencing —
 * how many are actually taken, and whether the book is flat — is the engine's
 * job, not this function's.
 */
export function detectTriggers(
  session: Session,
  range: OpeningRange,
  filters: TriggerFilters,
): Trigger[] {
  const triggers: Trigger[] = [];
  const volumeFloor = range.meanVolume * filters.volumeMultiple;

  for (const bar of session.bars) {
    if (bar.etMinutes < range.endEtMinutes || bar.etMinutes >= filters.cutoffEtMinutes) {
      continue;
    }
    if (bar.volume < volumeFloor) {
      continue;
    }

    const buffer = bar.close * filters.breakoutBufferPct;
    const brokeUp = bar.close > range.high + buffer;
    const brokeDown = bar.close < range.low - buffer;
    if (!brokeUp && !brokeDown) {
      continue;
    }

    const direction: "long" | "short" = brokeUp ? "long" : "short";
    if (filters.requireVwapAlign) {
      const aligned =
        direction === "long" ? bar.close > bar.sessionVwap : bar.close < bar.sessionVwap;
      if (!aligned) {
        continue;
      }
    }
    if (filters.requirePriorCloseAlign && session.priorClose != null) {
      const aligned =
        direction === "long" ? bar.close > session.priorClose : bar.close < session.priorClose;
      if (!aligned) {
        continue;
      }
    }

    triggers.push({
      timestamp: bar.timestamp,
      etMinutes: bar.etMinutes,
      spot: bar.close,
      direction,
    });
  }

  return triggers;
}
