import { describe, expect, it } from "vitest";
import { BacktestParamsSchema } from "@/domain/backtest";
import type { Bar } from "@/domain/types";
import { runBacktest } from "./engine";

const DATE = "2026-08-31"; // a Monday, EDT

function minuteBar(minute: number, price: number, volume: number, spread: number): Bar {
  return {
    symbol: "SPY",
    assetClass: "stock",
    open: price,
    high: price + spread,
    low: price - spread,
    close: price,
    volume,
    timestamp: new Date(new Date(`${DATE}T13:30:00Z`).getTime() + minute * 60_000).toISOString(),
  };
}

/**
 * 40 prior sessions calibrated to ~15% annualised realised vol — roughly where
 * SPY actually sits. A flatter series prices the vertical near zero and the
 * engine's debit/width guard correctly refuses to trade it.
 */
function dailyBars(): Bar[] {
  const closes = [640];
  for (let i = 1; i < 40; i += 1) {
    closes.push(closes[i - 1] * Math.exp(0.0134 * Math.sin(i * 2.4)));
  }
  return closes.map((close, i) => {
    const day = new Date("2026-06-01T00:00:00Z");
    day.setUTCDate(day.getUTCDate() + i);
    return {
      symbol: "SPY",
      assetClass: "stock" as const,
      open: close,
      high: close + 2,
      low: close - 2,
      close,
      volume: 1_000_000,
      timestamp: `${day.toISOString().slice(0, 10)}T20:00:00Z`,
    };
  });
}

/** Opening range 639–641 on thin volume, so any later high-volume bar clears the floor. */
function openingRangeBars(): Bar[] {
  return [
    minuteBar(0, 640, 1000, 1),
    minuteBar(5, 640.5, 1000, 0.5),
    minuteBar(10, 639.5, 1000, 0.5),
  ];
}

function deps(minute: Bar[]) {
  return {
    getBarsRange: async (_symbol: string, timeframe: "1Min" | "1Day") =>
      timeframe === "1Day" ? dailyBars() : minute,
  };
}

const PARAMS = {
  underlyings: ["SPY"],
  start: DATE,
  end: DATE,
  breakoutBufferPct: 0,
  volumeMultiple: 1.5,
  requireVwapAlign: false,
  requirePriorCloseAlign: false,
};

describe("runBacktest", () => {
  it("takes no trade when nothing breaks the opening range", async () => {
    const bars = [...openingRangeBars(), minuteBar(30, 640.2, 9000, 0.2)];
    const result = await runBacktest(BacktestParamsSchema.parse(PARAMS), deps(bars));
    expect(result.trades).toHaveLength(0);
    expect(result.sessionsScanned).toBe(1);
    expect(result.sessionsWithTrigger).toBe(0);
    expect(result.stats.finalEquity).toBe(100_000);
  });

  it("runs a breakout to the short strike and books a win", async () => {
    const bars = [
      ...openingRangeBars(),
      minuteBar(20, 642.5, 9000, 0.2), // breaks 641 -> long
      minuteBar(25, 644, 5000, 0.3),
      minuteBar(30, 646, 5000, 0.5), // sweeps through the short strike
      minuteBar(35, 647, 5000, 0.5),
    ];
    const result = await runBacktest(BacktestParamsSchema.parse(PARAMS), deps(bars));

    expect(result.trades).toHaveLength(1);
    const [trade] = result.trades;
    expect(trade.direction).toBe("long");
    expect(trade.kind).toBe("bull_call_spread");
    expect(trade.shortStrike).toBe(trade.longStrike + trade.width);
    expect(trade.exits.map((e) => e.reason)).toContain("target");
    expect(trade.pnl).toBeGreaterThan(0);
    expect(result.stats.finalEquity).toBeGreaterThan(100_000);
    expect(result.stats.targetReachedRate).toBe(1);
  });

  it("caps the loss near the full debit when the stop fires", async () => {
    const bars = [
      ...openingRangeBars(),
      minuteBar(20, 642.5, 9000, 0.2), // breaks out
      minuteBar(25, 641.5, 5000, 1.5), // low 640 falls back through the range high
      minuteBar(30, 639, 5000, 0.5),
    ];
    const params = BacktestParamsSchema.parse(PARAMS);
    const result = await runBacktest(params, deps(bars));

    expect(result.trades).toHaveLength(1);
    const [trade] = result.trades;
    expect(trade.exits.at(-1)?.reason).toBe("stop");
    expect(trade.pnl).toBeLessThan(0);
    // The whole point of stopRecoveryPct: the average loss sits near the max.
    expect(Math.abs(trade.pnl)).toBeGreaterThanOrEqual(0.85 * trade.riskAmount);
    expect(trade.avgExitValue).toBeLessThanOrEqual(params.stopRecoveryPct * trade.entryDebit);
  });

  it("returns more of the debit when stopRecoveryPct is relaxed", async () => {
    const bars = [
      ...openingRangeBars(),
      minuteBar(20, 642.5, 9000, 0.2),
      minuteBar(25, 641.5, 5000, 1.5),
    ];
    const pessimistic = await runBacktest(
      BacktestParamsSchema.parse({ ...PARAMS, stopRecoveryPct: 0.15 }),
      deps(bars),
    );
    const generous = await runBacktest(
      BacktestParamsSchema.parse({ ...PARAMS, stopRecoveryPct: 0.6 }),
      deps(bars),
    );
    expect(generous.trades[0].pnl).toBeGreaterThan(pessimistic.trades[0].pnl);
  });

  it("sizes the position off the full debit, within the risk budget", async () => {
    const bars = [
      ...openingRangeBars(),
      minuteBar(20, 642.5, 9000, 0.2),
      minuteBar(30, 646, 5000, 0.5),
    ];
    const params = BacktestParamsSchema.parse({ ...PARAMS, riskPerTradePct: 0.01 });
    const result = await runBacktest(params, deps(bars));
    const [trade] = result.trades;

    expect(trade.riskAmount).toBe(trade.entryDebit * 100 * trade.contracts);
    expect(trade.riskAmount).toBeLessThanOrEqual(100_000 * 0.01);
    // Rounding down to whole contracts should not waste more than one contract.
    expect(trade.riskAmount).toBeGreaterThan(100_000 * 0.01 - trade.entryDebit * 100);
  });

  it("sweeps anything still open at the end of the ladder", async () => {
    const bars = [
      ...openingRangeBars(),
      minuteBar(20, 642.5, 9000, 0.2),
      minuteBar(21, 642.6, 5000, 0.1),
      minuteBar(375, 642.7, 5000, 0.1), // 15:45 ET
    ];
    const result = await runBacktest(BacktestParamsSchema.parse(PARAMS), deps(bars));
    const reasons = result.trades[0].exits.map((e) => e.reason);
    expect(reasons.some((r) => r.startsWith("flatten") || r === "market_sweep")).toBe(true);
    expect(result.trades[0].exits.reduce((a, e) => a + e.fraction, 0)).toBeCloseTo(1, 6);
  });

  it("does not chase a re-entry after the target is reached", async () => {
    const bars = [
      ...openingRangeBars(),
      minuteBar(20, 642.5, 9000, 0.2),
      minuteBar(30, 646, 5000, 0.5), // target
      minuteBar(35, 647, 5000, 0.5), // still beyond the range, but extended
    ];
    const guarded = await runBacktest(BacktestParamsSchema.parse(PARAMS), deps(bars));
    expect(guarded.trades).toHaveLength(1);

    const chasing = await runBacktest(
      BacktestParamsSchema.parse({ ...PARAMS, allowReentryAfterTarget: true }),
      deps(bars),
    );
    expect(chasing.trades.length).toBeGreaterThan(1);
  });

  it("allows a second attempt after a stop", async () => {
    const bars = [
      ...openingRangeBars(),
      minuteBar(20, 642.5, 9000, 0.2),
      minuteBar(25, 641.5, 5000, 1.5), // stopped back inside the range
      minuteBar(40, 643, 9000, 0.2), // fresh breakout
      minuteBar(50, 647, 5000, 0.5),
    ];
    const result = await runBacktest(BacktestParamsSchema.parse(PARAMS), deps(bars));
    expect(result.trades.length).toBeGreaterThan(1);
    expect(result.trades[0].exits.at(-1)?.reason).toBe("stop");
  });

  it("skips a session it cannot price rather than defaulting the IV", async () => {
    const bars = [...openingRangeBars(), minuteBar(20, 642.5, 9000, 0.2)];
    const result = await runBacktest(BacktestParamsSchema.parse(PARAMS), {
      getBarsRange: async (_s: string, timeframe: "1Min" | "1Day") =>
        timeframe === "1Day" ? [] : bars,
    });
    expect(result.trades).toHaveLength(0);
    expect(result.warnings.join(" ")).toContain("realised vol");
  });

  it("reports the break-even hit rate implied by the payoff ratio", async () => {
    const bars = [
      ...openingRangeBars(),
      minuteBar(20, 642.5, 9000, 0.2),
      minuteBar(30, 646, 5000, 0.5),
    ];
    const result = await runBacktest(BacktestParamsSchema.parse(PARAMS), deps(bars));
    const { payoffRatio, breakEvenHitRate } = result.stats;
    if (payoffRatio > 0) {
      expect(breakEvenHitRate).toBeCloseTo(1 / (1 + payoffRatio), 10);
    }
  });
});
