import { describe, expect, it } from "vitest";
import {
  TRIANGLE_TIMEFRAME_DEFAULTS,
  type TriangleBacktestParamsInput,
  TriangleBacktestParamsSchema,
} from "@/domain/backtest-triangle";
import type { Bar } from "@/domain/types";
import { INTRADAY_GEOMETRY, intradayBreakout } from "./__fixtures__/triangle-intraday";
import { breakoutSeries, interpolate } from "./__fixtures__/triangle-series";
import { optionPrice, tradingYears } from "./black-scholes";
import { toEastern } from "./orb";
import {
  autoStrikeStep,
  dateChunks,
  expirationFor,
  fetchRetryDelay,
  minutesToExpiry,
  runTriangleBacktest,
  sessionsBetween,
} from "./triangle-engine";

function parse(bars: Bar[], overrides: Partial<TriangleBacktestParamsInput>) {
  return TriangleBacktestParamsSchema.parse({
    underlyings: ["SPY"],
    benchmark: "SPY",
    start: bars[0].timestamp.slice(0, 10),
    end: bars[bars.length - 1].timestamp.slice(0, 10),
    // Disabled unless a test wants it, so the target and the stop are what fire.
    takeProfitPctOfMax: 1,
    ...overrides,
  });
}

/** Pacing and backoff waits are the engine's business, not the test's. */
const noSleep = async () => {};

/** Daily bars, daily calibration. */
function run(bars: Bar[], overrides: Partial<TriangleBacktestParamsInput> = {}) {
  return runTriangleBacktest(parse(bars, { timeframe: "1Day", ...overrides }), {
    getBarsRange: async () => bars,
    sleep: noSleep,
  });
}

/** 30-minute bars, timeframe left to its default. */
function runIntraday(bars: Bar[], overrides: Partial<TriangleBacktestParamsInput> = {}) {
  return runTriangleBacktest(parse(bars, overrides), {
    getBarsRange: async () => bars,
    sleep: noSleep,
  });
}

const flat = (price: number, count: number) => Array.from({ length: count }, () => price);
const seconds = (ts: string) => Math.floor(Date.parse(ts) / 1000);

describe("calendar helpers", () => {
  it("counts weekday sessions inclusively", () => {
    expect(sessionsBetween("2025-01-06", "2025-01-10")).toBe(5); // Mon → Fri
    expect(sessionsBetween("2025-01-10", "2025-01-13")).toBe(2); // Fri → Mon
  });

  it("expires on the first Friday on or after entry + dteDays", () => {
    expect(expirationFor("2025-01-06", 35)).toBe("2025-02-14");
    expect(expirationFor("2025-01-03", 7)).toBe("2025-01-10");
  });

  it("snaps the strike grid to listed increments", () => {
    expect(autoStrikeStep(40)).toBe(0.5);
    expect(autoStrikeStep(230)).toBe(1);
    expect(autoStrikeStep(650)).toBe(2.5);
  });
});

describe("minutesToExpiry", () => {
  // Monday 2025-06-02 → Friday 2025-06-06: five sessions, expiry day included.
  it("is whole sessions × 390 at the open, as the daily engine had it", () => {
    expect(minutesToExpiry("2025-06-02", 9 * 60 + 30, "2025-06-06")).toBe(
      sessionsBetween("2025-06-02", "2025-06-06") * 390,
    );
  });

  it("counts what is left of today's session plus 390 per later session", () => {
    expect(minutesToExpiry("2025-06-02", 11 * 60 + 30, "2025-06-06")).toBe(270 + 4 * 390);
    expect(minutesToExpiry("2025-06-02", 16 * 60, "2025-06-06")).toBe(4 * 390);
    expect(minutesToExpiry("2025-06-06", 15 * 60, "2025-06-06")).toBe(60);
  });

  it("is zero past expiry", () => {
    expect(minutesToExpiry("2025-06-09", 10 * 60, "2025-06-06")).toBe(0);
  });
});

describe("timeframe defaults", () => {
  it("resolves the 30-minute calibration when the timeframe is omitted", () => {
    const params = TriangleBacktestParamsSchema.parse({ start: "2025-01-01", end: "2025-12-31" });

    expect(params.timeframe).toBe("30Min");
    expect(params).toMatchObject(TRIANGLE_TIMEFRAME_DEFAULTS["30Min"]);
    expect(params).toMatchObject({
      lookbackBars: 130,
      minPatternBars: 26,
      cooldownBars: 13,
      stopCheck: "session_close",
      volumeLookbackSessions: 20,
      dteDays: 35,
      maxHoldDays: 15,
    });
  });

  it("keeps the original daily calibration on 1Day", () => {
    const params = TriangleBacktestParamsSchema.parse({
      start: "2025-01-01",
      end: "2025-12-31",
      timeframe: "1Day",
    });
    expect(params).toMatchObject({
      lookbackBars: 60,
      minPatternBars: 15,
      cooldownBars: 10,
      touchTolerancePct: 0.01,
      minHeightPct: 0.03,
      minSlopePctPerBar: 0.0005,
      breakoutBufferPct: 0.002,
      stopBufferPct: 0.02,
    });
  });

  it("lets an explicit value win over the timeframe default", () => {
    const params = TriangleBacktestParamsSchema.parse({
      start: "2025-01-01",
      end: "2025-12-31",
      lookbackBars: 260,
      stopBufferPct: 0.02,
    });
    expect(params.lookbackBars).toBe(260);
    expect(params.stopBufferPct).toBe(0.02);
    expect(params.minPatternBars).toBe(26);
  });
});

describe("runTriangleBacktest — daily bars", () => {
  it("enters at the next session's open and wins when the measured move is reached", async () => {
    const { bars, breakoutIndex } = breakoutSeries([
      ...interpolate([113, 123], 5).slice(1),
      ...flat(123, 5),
    ]);
    const result = await run(bars);

    expect(result.trades).toHaveLength(1);
    const [trade] = result.trades;
    expect(trade.entryTimestamp).toBe(bars[breakoutIndex + 1].timestamp);
    expect(trade.entrySpot).toBe(bars[breakoutIndex + 1].open);
    expect(trade.exitReason).toBe("target");
    expect(trade.exitSpot).toBeCloseTo(121.5, 6);
    expect(trade.targetReached).toBe(true);
    expect(trade.structure).toBe("bull_call_spread");
    expect(trade.shortStrike).toBeGreaterThan(trade.longStrike);
    expect(trade.pnl).toBeGreaterThan(0);
    expect(result.funnel.taken).toBe(1);
  });

  it("stops out when price closes back under the old lid, and loses", async () => {
    const { bars } = breakoutSeries([...interpolate([113, 105], 4).slice(1), ...flat(105, 5)]);
    const result = await run(bars);

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitReason).toBe("stop");
    expect(result.trades[0].exitSpot).toBeLessThan(110.5 * 0.98);
    expect(result.trades[0].pnl).toBeLessThan(0);
  });

  it("closes on the time stop after `maxHoldDays` sessions", async () => {
    const { bars } = breakoutSeries(flat(114, 20));
    const result = await run(bars, { maxHoldDays: 5 });

    expect(result.trades[0].exitReason).toBe("time_stop");
    expect(result.trades[0].holdingDays).toBe(5);
  });

  it("refuses a trade one contract of which would exceed the risk budget", async () => {
    const { bars } = breakoutSeries(flat(114, 10));
    const result = await run(bars, { riskPerTradePct: 0.0001 });

    expect(result.trades).toHaveLength(0);
    expect(result.funnel.breakouts).toBe(1);
    expect(result.funnel.skippedSizing).toBe(1);
  });

  it("respects the book's position cap across underlyings", async () => {
    const { bars } = breakoutSeries(flat(114, 10));
    const result = await run(bars, { underlyings: ["AAA", "BBB"], maxOpenPositions: 1 });

    expect(result.funnel.breakouts).toBe(2);
    expect(result.trades).toHaveLength(1);
    expect(result.funnel.skippedCapacity).toBe(1);
  });

  it("prices a naked long call when asked", async () => {
    const { bars } = breakoutSeries([...interpolate([113, 123], 5).slice(1), ...flat(123, 5)]);
    const result = await run(bars, { structure: "long_call" });

    expect(result.trades[0].structure).toBe("long_call");
    expect(result.trades[0].shortStrike).toBeNull();
    expect(result.trades[0].pnl).toBeGreaterThan(0);
  });

  it("marks one equity point per session and reconciles to the trades' P&L", async () => {
    const { bars } = breakoutSeries([...interpolate([113, 105], 4).slice(1), ...flat(105, 5)]);
    const result = await run(bars);
    const totalPnl = result.trades.reduce((a, t) => a + t.pnl, 0);

    expect(result.equityCurve).toHaveLength(bars.length);
    expect(result.sessionsScanned).toBe(bars.length);
    expect(result.stats.finalEquity).toBeCloseTo(100_000 + totalPnl, 6);
    expect(result.stats.totalPnl).toBeCloseTo(totalPnl, 6);
    expect(result.benchmarkCurve).toHaveLength(bars.length);

    // The chart window: 25 bars before the first touch, 15 after the exit.
    const [trade] = result.trades;
    const window = result.barsByTrade[trade.id];
    const startIndex = bars.findIndex((b) => b.timestamp === trade.triangle.startTimestamp);
    const exitIndex = bars.findIndex((b) => b.timestamp === trade.exitTimestamp);
    expect(window[0][0]).toBe(seconds(bars[Math.max(0, startIndex - 25)].timestamp));
    expect(window.at(-1)?.[0]).toBe(
      seconds(bars[Math.min(bars.length - 1, exitIndex + 15)].timestamp),
    );
  });

  it("closes whatever is still open on the last session", async () => {
    const { bars } = breakoutSeries(flat(114, 3));
    const result = await run(bars);

    expect(result.trades[0].exitReason).toBe("end_of_data");
    expect(result.equityCurve.at(-1)?.equity).toBeCloseTo(result.stats.finalEquity, 6);
  });
});

describe("runTriangleBacktest — 30-minute triggers", () => {
  it("enters at the open of the bar after an in-session breakout", async () => {
    const { bars, breakoutIndex } = intradayBreakout(flat(111, 30));
    const result = await runIntraday(bars);

    expect(result.params.timeframe).toBe("30Min");
    expect(result.params.lookbackBars).toBe(130);
    expect(result.funnel.breakouts).toBe(1);
    expect(result.trades).toHaveLength(1);
    const [trade] = result.trades;
    expect(toEastern(trade.triangle.breakoutTimestamp).minutes).toBe(11 * 60);
    expect(trade.entryTimestamp).toBe(bars[breakoutIndex + 1].timestamp);
    expect(toEastern(trade.entryTimestamp).minutes).toBe(11 * 60 + 30);
    expect(trade.entrySpot).toBe(INTRADAY_GEOMETRY.breakoutClose);
    expect(trade.entryDate).toBe(toEastern(trade.triangle.breakoutTimestamp).date);
  });

  it("prices the entry on the trading minutes left from that bar, not whole sessions", async () => {
    const { bars } = intradayBreakout(flat(111, 30));
    const result = await runIntraday(bars, { structure: "long_call" });
    const [trade] = result.trades;

    const debitAt = (minutes: number) => {
      const long = optionPrice(
        "call",
        trade.entrySpot,
        trade.longStrike,
        tradingYears(minutes),
        0.04,
        trade.iv,
      );
      return long + Math.max(0.01, long * 0.03);
    };
    const minutes = minutesToExpiry(trade.entryDate, 11 * 60 + 30, trade.expiration);
    expect(minutes).toBe(270 + 390 * (sessionsBetween(trade.entryDate, trade.expiration) - 1));
    expect(trade.entryDebit).toBeCloseTo(debitAt(minutes), 10);
    expect(
      Math.abs(
        trade.entryDebit - debitAt(sessionsBetween(trade.entryDate, trade.expiration) * 390),
      ),
    ).toBeGreaterThan(1e-4);
  });

  it("enters at the next morning's 09:30 after a 15:30 breakout", async () => {
    const { bars, breakoutIndex } = intradayBreakout(flat(111, 30), { slot: 12 });
    const result = await runIntraday(bars);

    const [trade] = result.trades;
    const breakout = toEastern(trade.triangle.breakoutTimestamp);
    expect(breakout.minutes).toBe(15 * 60 + 30);
    expect(trade.entryTimestamp).toBe(bars[breakoutIndex + 1].timestamp);
    expect(toEastern(trade.entryTimestamp).minutes).toBe(9 * 60 + 30);
    expect(trade.entryDate > breakout.date).toBe(true);
    expect(trade.entrySpot).toBe(INTRADAY_GEOMETRY.breakoutClose);
  });

  it("counts a 15:30 breakout with no bar after it as skipped data", async () => {
    const { bars } = intradayBreakout([], { slot: 12 });
    const result = await runIntraday(bars);

    expect(result.funnel.breakouts).toBe(1);
    expect(result.funnel.skippedData).toBe(1);
    expect(result.trades).toHaveLength(0);
  });

  it("does not confirm a 15:30 breakout on the closing bar's ordinary volume", async () => {
    const { bars } = intradayBreakout(flat(111, 30), { slot: 12, breakoutVolume: 8_000 });
    const result = await runIntraday(bars);

    expect(result.funnel.breakouts).toBe(0);
    expect(result.funnel.rejectedVolume).toBe(1);
  });

  it("ignores pre-market and after-hours bars entirely", async () => {
    const after = [...interpolate([110.6, 112.6], 6).slice(1), ...flat(112.6, 13)];
    const plain = await runIntraday(intradayBreakout(after).regular);
    const extended = await runIntraday(intradayBreakout(after, { extended: true }).bars);

    expect(plain.trades).toHaveLength(1);
    expect(extended.trades).toEqual(plain.trades);
    expect(extended.equityCurve).toEqual(plain.equityCurve);
    expect(extended.benchmarkCurve).toEqual(plain.benchmarkCurve);
    for (const window of Object.values(extended.barsByTrade)) {
      for (const [time] of window) {
        const { minutes } = toEastern(new Date(time * 1000).toISOString());
        expect(minutes >= 9 * 60 + 30 && minutes < 16 * 60).toBe(true);
      }
    }
  });

  it("exits at the target on the bar whose high reaches it", async () => {
    const { bars, breakoutIndex } = intradayBreakout([
      ...interpolate([110.6, 112.6], 6).slice(1),
      ...flat(112.6, 13),
    ]);
    const result = await runIntraday(bars);

    const [trade] = result.trades;
    expect(trade.exitReason).toBe("target");
    expect(trade.exitTimestamp).toBe(bars[breakoutIndex + 5].timestamp);
    expect(trade.exitSpot).toBeCloseTo(INTRADAY_GEOMETRY.target, 6);
    expect(trade.exitDate).toBe(trade.entryDate);
    expect(trade.holdingDays).toBe(1);
    expect(trade.targetReached).toBe(true);
    // No P&L assertion: on a 2% pattern the 35-DTE 0.45-delta long strike sits
    // above the target, so the spread degenerates to one strike step and
    // friction eats it — the mechanics are what this test pins (docs/09 §6).
  });

  describe("stop check", () => {
    // Entry 11:30 at 110.6; the 12:30 bar closes at 109, under the 109.22 stop
    // (110.1 × (1 − 0.8%)); the session closes back at 111.
    const after = [110.6, 110.2, 109, 109, 110, 110.6, 111, 111, 111, ...flat(111, 26)];

    it("holds through an intraday close under the stop when the session closes above it", async () => {
      const { bars } = intradayBreakout(after);
      const result = await runIntraday(bars, { maxHoldDays: 2 });

      const [trade] = result.trades;
      expect(trade.stopLevel).toBeCloseTo(INTRADAY_GEOMETRY.resistance * (1 - 0.008), 6);
      expect(trade.exitReason).toBe("time_stop");
      expect(trade.holdingDays).toBe(2);
    });

    it("stops on that bar with `stopCheck: bar_close`", async () => {
      const { bars, breakoutIndex } = intradayBreakout(after);
      const result = await runIntraday(bars, { maxHoldDays: 2, stopCheck: "bar_close" });

      const [trade] = result.trades;
      expect(trade.exitReason).toBe("stop");
      expect(trade.exitTimestamp).toBe(bars[breakoutIndex + 3].timestamp);
      expect(trade.exitSpot).toBe(109);
      expect(trade.exitDate).toBe(trade.entryDate);
    });
  });

  it("marks one equity point per session and reconciles to the trades' P&L", async () => {
    const { bars } = intradayBreakout([
      ...[110.6, 110.2, 109, 109, 110, 110.6, 111, 111, 111],
      ...flat(108, 26),
    ]);
    const result = await runIntraday(bars);
    const sessions = new Set(bars.map((b) => b.timestamp.slice(0, 10))).size;
    const totalPnl = result.trades.reduce((a, t) => a + t.pnl, 0);

    expect(result.trades[0].exitReason).toBe("stop");
    expect(result.equityCurve).toHaveLength(sessions);
    expect(result.sessionsScanned).toBe(sessions);
    expect(result.benchmarkCurve).toHaveLength(sessions);
    expect(result.stats.finalEquity).toBeCloseTo(100_000 + totalPnl, 6);
  });

  it("fetches at most two symbols at once", async () => {
    const { bars } = intradayBreakout(flat(111, 30));
    let inFlight = 0;
    let peak = 0;
    const underlyings = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
    await runTriangleBacktest(parse(bars, { underlyings }), {
      getBarsRange: async (symbol) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return bars.map((b) => ({ ...b, symbol }));
      },
      sleep: noSleep,
    });
    expect(peak).toBe(2);
  });
});

describe("bar fetching under the data rate limit", () => {
  const { bars } = intradayBreakout(flat(111, 30));
  const params = parse(bars, {});
  /** Waits longer than the pacer ever imposes: the retry waits. */
  const retryWaits = (delays: number[]) => delays.filter((ms) => ms >= 1_000);

  it("requests 30-minute history a year at a time and daily history in one call", async () => {
    const calls: { timeframe: string; from: string; to: string }[] = [];
    const record = async (_symbol: string, timeframe: string, from: string, to: string) => {
      calls.push({ timeframe, from, to });
      return bars;
    };
    const window = { start: "2023-01-03", end: "2025-06-30" };
    await runTriangleBacktest(parse(bars, window), { getBarsRange: record, sleep: noSleep });
    const intraday = calls.splice(0);
    await runTriangleBacktest(parse(bars, { ...window, timeframe: "1Day" }), {
      getBarsRange: record,
      sleep: noSleep,
    });

    expect(calls).toEqual([{ timeframe: "1Day", from: "2022-06-17", to: "2025-06-30" }]);
    expect(intraday[0].from).toBe("2022-06-17"); // start − 200 days
    expect(intraday.at(-1)?.to).toBe("2025-06-30");
    expect(intraday).toHaveLength(dateChunks("2022-06-17", "2025-06-30", 365).length);
    for (const [i, call] of intraday.entries()) {
      expect(call.timeframe).toBe("30Min");
      const days = (Date.parse(call.to) - Date.parse(call.from)) / 86_400_000;
      expect(days).toBeLessThan(365);
      if (i > 0) {
        const dayAfter = new Date(Date.parse(intraday[i - 1].to) + 86_400_000);
        expect(call.from).toBe(dayAfter.toISOString().slice(0, 10));
      }
    }
  });

  it("waits out the rate-limit window after a failure with no HTTP status", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await runTriangleBacktest(params, {
      getBarsRange: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error(
            "The request failed and the interceptors did not return an alternative response",
          );
        }
        return bars;
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
      now: () => 0,
    });

    expect(calls).toBe(2);
    expect(retryWaits(delays)).toEqual([61_000]);
    expect(result.trades).toHaveLength(1);
  });

  it("waits until X-RateLimit-Reset after a 429 that carries it", async () => {
    let calls = 0;
    const delays: number[] = [];
    await runTriangleBacktest(params, {
      getBarsRange: async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new Error("too many requests."), {
            status: 429,
            rateLimit: { reset: new Date(90_000) },
          });
        }
        return bars;
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
      now: () => 0,
    });

    expect(retryWaits(delays)).toEqual([91_000]);
  });

  it("keeps the short backoff for a server error", () => {
    expect(
      fetchRetryDelay(Object.assign(new Error("bad gateway"), { status: 502 }), 3_000, 0),
    ).toBe(3_000);
    expect(fetchRetryDelay(Object.assign(new Error("slow"), { status: 429 }), 3_000, 0)).toBe(
      61_000,
    );
    expect(fetchRetryDelay(new Error("socket hang up"), 3_000, 0)).toBe(61_000);
  });

  it("gives up after the last attempt, naming the symbol", async () => {
    let calls = 0;
    await expect(
      runTriangleBacktest(params, {
        getBarsRange: async () => {
          calls += 1;
          throw new Error("socket hang up");
        },
        sleep: noSleep,
      }),
    ).rejects.toThrow("SPY: 30Min bars could not be fetched — socket hang up");
    expect(calls).toBe(4);
  });

  it("does not retry a request Alpaca rejected", async () => {
    let calls = 0;
    await expect(
      runTriangleBacktest(params, {
        getBarsRange: async () => {
          calls += 1;
          throw Object.assign(new Error("invalid symbol"), { status: 422 });
        },
        sleep: noSleep,
      }),
    ).rejects.toThrow("invalid symbol");
    expect(calls).toBe(1);
  });

  it("stops requesting once the client has gone away", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    await expect(
      runTriangleBacktest(params, {
        getBarsRange: async () => {
          calls += 1;
          return bars;
        },
        sleep: noSleep,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Backtest aborted: the client disconnected");
    expect(calls).toBe(0);
  });
});
