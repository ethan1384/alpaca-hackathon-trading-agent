import { describe, expect, it } from "vitest";
import type { Bar } from "@/domain/types";
import {
  detectTriggers,
  groupSessions,
  MARKET_OPEN_ET,
  openingRange,
  parseEtTime,
  toEastern,
} from "./orb";

/** A 1-minute bar `minute` minutes after the 09:30 ET open on `date` (EDT). */
function bar(date: string, minute: number, price: number, volume = 1000, spread = 0.2): Bar {
  const open = new Date(`${date}T13:30:00Z`).getTime() + minute * 60_000;
  return {
    symbol: "SPY",
    assetClass: "stock",
    open: price,
    high: price + spread,
    low: price - spread,
    close: price,
    volume,
    timestamp: new Date(open).toISOString(),
  };
}

const FILTERS = {
  breakoutBufferPct: 0,
  volumeMultiple: 1.5,
  requireVwapAlign: false,
  requirePriorCloseAlign: false,
  cutoffEtMinutes: parseEtTime("14:00"),
};

describe("toEastern", () => {
  it("converts a UTC instant to the eastern session date and minute", () => {
    expect(toEastern("2026-08-31T13:30:00Z")).toEqual({ date: "2026-08-31", minutes: 570 });
  });

  it("handles the standard-time offset", () => {
    // January is EST (UTC-5), so 14:30Z is the 09:30 open.
    expect(toEastern("2026-01-05T14:30:00Z")).toEqual({ date: "2026-01-05", minutes: 570 });
  });

  it("keeps a late-evening UTC instant on the prior eastern date", () => {
    expect(toEastern("2026-09-01T01:00:00Z")).toEqual({ date: "2026-08-31", minutes: 21 * 60 });
  });
});

describe("groupSessions", () => {
  it("drops bars outside regular hours", () => {
    const bars = [
      { ...bar("2026-08-31", 0, 640), timestamp: "2026-08-31T11:00:00Z" }, // 07:00 ET, pre-market
      bar("2026-08-31", 0, 640),
      { ...bar("2026-08-31", 0, 640), timestamp: "2026-08-31T21:00:00Z" }, // 17:00 ET, post
    ];
    const [session] = groupSessions(bars);
    expect(session.bars).toHaveLength(1);
    expect(session.bars[0].etMinutes).toBe(MARKET_OPEN_ET);
  });

  it("orders sessions and carries the prior close forward", () => {
    const sessions = groupSessions([
      bar("2026-09-01", 0, 645),
      bar("2026-08-31", 0, 640),
      bar("2026-08-31", 1, 641),
    ]);
    expect(sessions.map((s) => s.date)).toEqual(["2026-08-31", "2026-09-01"]);
    expect(sessions[0].priorClose).toBeNull();
    expect(sessions[1].priorClose).toBe(641);
  });

  it("accumulates VWAP across the session, not per bar", () => {
    const sessions = groupSessions([
      bar("2026-08-31", 0, 100, 1000, 0),
      bar("2026-08-31", 1, 200, 3000, 0),
    ]);
    // (100*1000 + 200*3000) / 4000 = 175
    expect(sessions[0].bars[1].sessionVwap).toBeCloseTo(175, 6);
  });
});

describe("openingRange", () => {
  it("spans only the first N minutes", () => {
    const [session] = groupSessions([
      bar("2026-08-31", 0, 640, 1000, 1), // 639 - 641
      bar("2026-08-31", 14, 642, 3000, 1), // 641 - 643
      bar("2026-08-31", 20, 700, 1000, 1), // outside the range
    ]);
    const range = openingRange(session, 15);
    expect(range).not.toBeNull();
    expect(range?.high).toBe(643);
    expect(range?.low).toBe(639);
    expect(range?.size).toBe(4);
    expect(range?.meanVolume).toBe(2000);
    expect(range?.endEtMinutes).toBe(MARKET_OPEN_ET + 15);
  });

  it("returns null for a session with no bars in the window", () => {
    const [session] = groupSessions([bar("2026-08-31", 30, 640)]);
    expect(openingRange(session, 15)).toBeNull();
  });
});

describe("detectTriggers", () => {
  function build(extra: Bar[]) {
    const bars = [bar("2026-08-31", 0, 640, 1000, 1), bar("2026-08-31", 5, 640, 1000, 1), ...extra];
    const [session] = groupSessions(bars);
    const range = openingRange(session, 15);
    if (!range) {
      throw new Error("expected a range");
    }
    return { session, range };
  }

  it("fires on a close beyond the range high with confirming volume", () => {
    const { session, range } = build([bar("2026-08-31", 20, 643, 5000, 0)]);
    const triggers = detectTriggers(session, range, FILTERS);
    expect(triggers).toHaveLength(1);
    expect(triggers[0].direction).toBe("long");
    expect(triggers[0].spot).toBe(643);
  });

  it("rejects a breakout on thin volume", () => {
    const { session, range } = build([bar("2026-08-31", 20, 643, 100, 0)]);
    expect(detectTriggers(session, range, FILTERS)).toHaveLength(0);
  });

  it("rejects a close that does not clear the buffer", () => {
    const { session, range } = build([bar("2026-08-31", 20, 641.05, 5000, 0)]);
    // Range high is 641; a 0.1% buffer needs ~641.64.
    const triggers = detectTriggers(session, range, { ...FILTERS, breakoutBufferPct: 0.001 });
    expect(triggers).toHaveLength(0);
  });

  it("does not fire inside the opening range window", () => {
    const { session, range } = build([bar("2026-08-31", 10, 660, 9000, 0)]);
    expect(detectTriggers(session, range, FILTERS)).toHaveLength(0);
  });

  it("stops firing at the cutoff", () => {
    const { session, range } = build([bar("2026-08-31", 300, 643, 5000, 0)]); // 14:30 ET
    expect(detectTriggers(session, range, FILTERS)).toHaveLength(0);
  });

  it("fires short below the range low", () => {
    const { session, range } = build([bar("2026-08-31", 20, 637, 5000, 0)]);
    const triggers = detectTriggers(session, range, FILTERS);
    expect(triggers[0].direction).toBe("short");
  });

  it("rejects a long that breaks out below session VWAP", () => {
    // A heavy bar well above the range drags session VWAP up to ~659.9, so the
    // later breakout at 642 clears the range high but sits far below VWAP.
    // Volume filtering is off so this asserts the VWAP gate alone -- that same
    // heavy bar would otherwise lift the range's mean volume and reject the
    // breakout for the wrong reason.
    const noVolumeFloor = { ...FILTERS, volumeMultiple: 0 };
    const { session, range } = build([
      bar("2026-08-31", 16, 660, 500_000, 0),
      bar("2026-08-31", 20, 642, 5000, 0),
    ]);
    const last = session.bars.at(-1);
    expect(last?.close).toBe(642);
    expect(last?.sessionVwap).toBeGreaterThan(642);

    const permissive = detectTriggers(session, range, noVolumeFloor);
    const strict = detectTriggers(session, range, { ...noVolumeFloor, requireVwapAlign: true });
    expect(permissive.map((t) => t.spot)).toEqual([660, 642]);
    expect(strict.map((t) => t.spot)).toEqual([660]);
  });

  it("rejects a long below the prior session close", () => {
    const bars = [
      bar("2026-08-28", 0, 700, 1000, 0),
      bar("2026-08-31", 0, 640, 1000, 1),
      bar("2026-08-31", 20, 643, 5000, 0),
    ];
    const sessions = groupSessions(bars);
    const session = sessions[1];
    const range = openingRange(session, 15);
    if (!range) {
      throw new Error("expected a range");
    }
    expect(session.priorClose).toBe(700);
    expect(
      detectTriggers(session, range, { ...FILTERS, requirePriorCloseAlign: true }),
    ).toHaveLength(0);
  });
});

describe("parseEtTime", () => {
  it("converts HH:MM to minutes from midnight", () => {
    expect(parseEtTime("09:30")).toBe(570);
    expect(parseEtTime("15:45")).toBe(945);
  });
});
