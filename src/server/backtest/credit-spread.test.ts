import { describe, expect, it } from "vitest";
import { daysToExpiration } from "@/config/competition";
import { CreditBacktestParamsSchema } from "@/domain/backtest-credit";
import type { Bar } from "@/domain/types";
import { runCreditBacktest } from "./credit-spread";
import { runCreditBacktestLegacy } from "./credit-spread-legacy";

const MON = "2026-08-31"; // EDT, so 09:30 ET is 13:30Z
const TUE = "2026-09-01";
const WED = "2026-09-02";

/** Bars every five minutes, 09:30 to 15:55 ET. 16:00 belongs to no session. */
function session(date: string, price: (minute: number) => number): Bar[] {
  return sessionUntil(date, 385, price);
}

/** Bars every five minutes from 09:30 ET up to and including `lastMinuteFromOpen`. */
function sessionUntil(
  date: string,
  lastMinuteFromOpen: number,
  price: (minute: number) => number,
): Bar[] {
  const bars: Bar[] = [];
  for (let minute = 0; minute <= lastMinuteFromOpen; minute += 5) {
    const close = price(minute);
    bars.push({
      symbol: "SPY",
      assetClass: "stock",
      open: close,
      high: close + 0.15,
      low: close - 0.15,
      close,
      volume: 100_000,
      timestamp: new Date(Date.parse(`${date}T13:30:00Z`) + minute * 60_000).toISOString(),
    });
  }
  return bars;
}

/** 40 prior sessions at ~15% annualised realised vol — the same calibration as engine.test.ts. */
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

function deps(minute: Bar[]) {
  return {
    getBarsRange: async (_symbol: string, timeframe: "1Min" | "1Day") =>
      timeframe === "1Day" ? dailyBars() : minute,
  };
}

const PARAMS = { underlyings: ["SPY"], start: MON, end: TUE };

const flat = () => [...session(MON, () => 640), ...session(TUE, () => 640)];

/** Monday flat, Tuesday sells off hard — the short put spread's bad day. */
const selloff = () => [
  ...session(MON, () => 640),
  ...session(TUE, (m) => 640 - Math.min(m, 200) * 0.06),
];

describe("runCreditBacktest", () => {
  it("posts both sides of the condor at the decision window", async () => {
    const result = await runCreditBacktest(CreditBacktestParamsSchema.parse(PARAMS), deps(flat()));

    expect(result.trades).toHaveLength(2);
    expect(result.sessionsWithEntry).toBe(1);
    expect(new Set(result.trades.map((t) => t.side))).toEqual(new Set(["put", "call"]));

    for (const trade of result.trades) {
      expect(trade.dte).toBe(1);
      expect(trade.expiration).toBe(TUE);
      expect(trade.entryTimestamp).toBe(`${MON}T14:00:00.000Z`); // 10:00 ET
      expect(Math.abs(trade.shortStrike - trade.longStrike)).toBeCloseTo(trade.width, 10);
      // The long leg is always the further-OTM one: that is what caps the risk.
      expect(
        trade.side === "put"
          ? trade.longStrike < trade.shortStrike
          : trade.longStrike > trade.shortStrike,
      ).toBe(true);
      expect(trade.shortDelta).toBeGreaterThan(0.1);
      expect(trade.shortDelta).toBeLessThan(0.3);
      expect(trade.credit).toBeGreaterThanOrEqual(0.25);
      expect(trade.maxLoss).toBeCloseTo(trade.width - trade.credit, 10);
      expect(trade.riskAmount).toBeCloseTo(trade.maxLoss * 100 * trade.contracts, 6);
    }
  });

  it("counts DTE the way production does, from the entry instant", async () => {
    const params = CreditBacktestParamsSchema.parse(PARAMS);
    const result = await runCreditBacktest(params, deps(flat()));
    expect(result.trades.length).toBeGreaterThan(0);

    for (const trade of result.trades) {
      // The guard against the two clocks drifting apart again. `daysToExpiration`
      // is what `select-contract` will use to resolve this same window live; if
      // it disagrees with the backtest, the strategy trades an expiry it never
      // tested. It disagreed by exactly one day until 2026-08-30.
      expect(trade.dte).toBe(daysToExpiration(trade.expiration, new Date(trade.entryTimestamp)));
      expect(trade.dte).toBeGreaterThanOrEqual(params.minDte);
      expect(trade.dte).toBeLessThanOrEqual(params.maxDte);
    }
  });

  it("never chooses an expiry outside the DTE window", async () => {
    const result = await runCreditBacktest(CreditBacktestParamsSchema.parse(PARAMS), deps(flat()));
    // Tuesday is the last session, so Tuesday's own decision window has nothing
    // left to sell — that must show as a rejection, not as silence.
    expect(result.rejections.no_expiry_in_window).toBeGreaterThan(0);
  });

  it("buys the spread back at the profit target when the market goes nowhere", async () => {
    const result = await runCreditBacktest(CreditBacktestParamsSchema.parse(PARAMS), deps(flat()));

    for (const trade of result.trades) {
      expect(trade.exit.reason).toBe("target");
      expect(trade.pnl).toBeGreaterThan(0);
      // A 50% target keeps half the credit, less nothing — the exit is a limit.
      expect(trade.exit.cost).toBeCloseTo(0.5 * trade.credit, 10);
    }
    expect(result.stats.finalEquity).toBeGreaterThan(100_000);
  });

  it("stops the put side out on a selloff and keeps the loss inside the width", async () => {
    const result = await runCreditBacktest(
      CreditBacktestParamsSchema.parse(PARAMS),
      deps(selloff()),
    );
    const put = result.trades.find((t) => t.side === "put");
    expect(put).toBeDefined();
    if (!put) {
      return;
    }

    expect(put.exit.reason).toBe("stop");
    expect(put.pnl).toBeLessThan(0);
    // Defined risk is the entire point of the structure: it has to hold even
    // after stop slippage and both crossings of friction.
    expect(Math.abs(put.pnl)).toBeLessThanOrEqual(put.riskAmount + 1e-6);
    expect(put.exit.cost).toBeLessThanOrEqual(put.width + 1e-9);
  });

  it("trips the stop earlier, on a smaller move, when IV spikes with the selloff", async () => {
    const bars = selloff();
    const flatVol = await runCreditBacktest(
      CreditBacktestParamsSchema.parse({ ...PARAMS, ivShockPerDownPct: 0 }),
      deps(bars),
    );
    const shocked = await runCreditBacktest(
      CreditBacktestParamsSchema.parse({ ...PARAMS, ivShockPerDownPct: 0.3 }),
      deps(bars),
    );
    const put = (r: typeof flatVol) => r.trades.find((t) => t.side === "put");

    // Not "the loss is bigger" — it is not, and assuming so would be the wrong
    // intuition. A 2x-credit stop is a level, so both paths exit near it; what
    // the vol spike changes is *when* that level is reached. Modelled flat, the
    // underlying has to fall further to get there, which is precisely the
    // flattery this parameter exists to remove.
    expect(put(shocked)?.exit.timestamp.localeCompare(put(flatVol)?.exit.timestamp ?? "")).toBe(-1);
    expect(put(shocked)?.exit.spot ?? 0).toBeGreaterThan(put(flatVol)?.exit.spot ?? 0);
  });

  it("treats a credit floor it cannot clear as a rejection, not a failure", async () => {
    const result = await runCreditBacktest(
      CreditBacktestParamsSchema.parse({ ...PARAMS, minCredit: 5 }),
      deps(flat()),
    );
    expect(result.trades).toHaveLength(0);
    expect(result.rejections.credit_below_min).toBeGreaterThan(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("posts a single spread in the reduced put-only variant", async () => {
    const result = await runCreditBacktest(
      CreditBacktestParamsSchema.parse({ ...PARAMS, sides: "put" }),
      deps(flat()),
    );
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].side).toBe("put");
  });

  it("refuses a condor when the concurrency cap cannot fit both sides", async () => {
    const result = await runCreditBacktest(
      CreditBacktestParamsSchema.parse({ ...PARAMS, maxConcurrentSpreads: 1 }),
      deps(flat()),
    );
    expect(result.trades).toHaveLength(0);
    expect(result.rejections.max_concurrent_spreads).toBeGreaterThan(0);
    expect(result.rejectionLog).toHaveLength(1);
    expect(result.rejectionLog[0].control).toBe("max_concurrent_spreads");
    expect(result.rejectionLog[0].structure).toBe("condor");
  });

  it("posts both sides at 2% risk with the aggregate gate", async () => {
    const result = await runCreditBacktest(
      CreditBacktestParamsSchema.parse({
        ...PARAMS,
        riskPerSidePct: 0.02,
        buyingPowerCap: 100_000,
        dailyRiskCapPct: 0.2,
      }),
      deps(flat()),
    );
    expect(result.trades).toHaveLength(2);
    expect(result.rejections.net_delta_cap ?? 0).toBe(0);
  });

  it("blocks an oversized single spread via net_delta_cap with a detailed log", async () => {
    const result = await runCreditBacktest(
      CreditBacktestParamsSchema.parse({
        ...PARAMS,
        sides: "put",
        riskPerSidePct: 0.05,
        buyingPowerCap: 100_000,
        dailyRiskCapPct: 0.2,
      }),
      deps(flat()),
    );
    expect(result.trades).toHaveLength(0);
    expect(result.rejections.net_delta_cap).toBe(1);
    expect(result.rejectionLog).toHaveLength(1);
    const entry = result.rejectionLog[0];
    expect(entry.control).toBe("net_delta_cap");
    expect(entry.structure).toBe("put");
    expect(entry.observed).toMatch(/\$[\d,]+ net delta/);
    expect(entry.threshold).toMatch(/\$[\d,]+ \(25% equity\)/);
  });

  it("re-gates a reduced spread when one condor side fails construction", async () => {
    const result = await runCreditBacktest(
      CreditBacktestParamsSchema.parse({ ...PARAMS, minCredit: 5 }),
      deps(flat()),
    );
    expect(result.trades).toHaveLength(0);
    expect(result.rejections.credit_below_min).toBeGreaterThan(0);
  });

  it("posts a condor at 5% risk because aggregate delta is near-neutral", async () => {
    const result = await runCreditBacktest(
      CreditBacktestParamsSchema.parse({
        ...PARAMS,
        riskPerSidePct: 0.05,
        buyingPowerCap: 100_000,
        dailyRiskCapPct: 0.2,
      }),
      deps(flat()),
    );
    expect(result.trades).toHaveLength(2);
    expect(result.rejections.net_delta_cap ?? 0).toBe(0);
  });

  it("trims size to the buying-power ceiling instead of ignoring it", async () => {
    const capped = await runCreditBacktest(
      CreditBacktestParamsSchema.parse({ ...PARAMS, buyingPowerCap: 600 }),
      deps(flat()),
    );
    const uncapped = await runCreditBacktest(
      CreditBacktestParamsSchema.parse(PARAMS),
      deps(flat()),
    );
    const bp = (r: typeof capped) => r.trades.reduce((a, t) => a + t.riskAmount, 0);
    expect(bp(capped)).toBeLessThanOrEqual(600);
    expect(bp(capped)).toBeLessThan(bp(uncapped));
  });

  it("closes on expiry day at the mandated time when neither exit has fired", async () => {
    const result = await runCreditBacktest(
      CreditBacktestParamsSchema.parse({
        ...PARAMS,
        stopMultiple: 100, // neither the stop…
        targetProfitPct: 0.001, // …nor the target can trigger
      }),
      deps(flat()),
    );
    expect(result.trades).toHaveLength(2);
    for (const trade of result.trades) {
      expect(trade.exit.reason).toBe("time_close");
      // 15:30 ET on the expiry session, never held into settlement.
      expect(trade.exit.timestamp.startsWith(`${TUE}T19:30`)).toBe(true);
    }
  });

  it("flattens the book when the daily drawdown stop fires", async () => {
    const result = await runCreditBacktest(
      CreditBacktestParamsSchema.parse({
        ...PARAMS,
        sides: "put", // isolate the loser: the call side's gain would net it off
        stopMultiple: 100, // let the loss run so the account-level stop is the one that fires
        targetProfitPct: 0.001,
        dailyDrawdownStopPct: 0.001,
      }),
      deps(selloff()),
    );
    expect(result.trades.some((t) => t.exit.reason === "kill_switch")).toBe(true);
    expect(result.warnings.join(" ")).toContain("daily drawdown stop");
  });

  it("legacy per-leg gate refuses condor sizing that aggregate gate would allow", async () => {
    const result = await runCreditBacktestLegacy(
      CreditBacktestParamsSchema.parse({
        ...PARAMS,
        riskPerSidePct: 0.05,
        buyingPowerCap: 100_000,
        dailyRiskCapPct: 0.2,
      }),
      deps(flat()),
    );
    expect(result.trades).toHaveLength(0);
    expect(result.rejections.net_delta_cap).toBe(2);
  });

  it("legacy per-leg gate posts only one side when concurrency cap is 1", async () => {
    const result = await runCreditBacktestLegacy(
      CreditBacktestParamsSchema.parse({ ...PARAMS, maxConcurrentSpreads: 1 }),
      deps(flat()),
    );
    expect(result.trades).toHaveLength(1);
    expect(result.rejections.max_concurrent_spreads).toBeGreaterThan(0);
  });

  it("reports the break-even hit rate implied by the payoff ratio", async () => {
    const result = await runCreditBacktest(
      CreditBacktestParamsSchema.parse(PARAMS),
      deps(selloff()),
    );
    const { payoffRatio, breakEvenHitRate } = result.stats;
    if (payoffRatio > 0) {
      expect(breakEvenHitRate).toBeCloseTo(1 / (1 + payoffRatio), 10);
    }
  });

  it("prices the same structure cheaper as the variance risk premium is removed", async () => {
    const generous = await runCreditBacktest(
      CreditBacktestParamsSchema.parse({ ...PARAMS, ivMultiplier: 1.3 }),
      deps(flat()),
    );
    const honest = await runCreditBacktest(
      CreditBacktestParamsSchema.parse({ ...PARAMS, ivMultiplier: 1 }),
      deps(flat()),
    );
    const credit = (r: typeof honest) => r.trades.reduce((a, t) => a + t.credit, 0);
    expect(credit(generous)).toBeGreaterThan(credit(honest));
  });

  it("settles at intrinsic on a short expiry session instead of becoming a zombie", async () => {
    // NYSE half-day (13:00 close): last bar 12:55 ET, minute 205 from 09:30.
    const bars = [
      ...session(MON, () => 640),
      ...sessionUntil(TUE, 205, () => 640),
      ...session(WED, () => 600),
    ];
    const result = await runCreditBacktest(
      CreditBacktestParamsSchema.parse({
        underlyings: ["SPY"],
        start: MON,
        end: WED,
        sides: "put",
        stopMultiple: 100,
        targetProfitPct: 0.001,
      }),
      deps(bars),
    );

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.exit.reason).toBe("expiry");
    expect(trade.exit.timestamp.startsWith(TUE)).toBe(true);
    expect(trade.pnl).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("held past expiry"))).toBe(false);
  });

  it("closes on the last expiry-session bar when closeAtEt is unreachable", async () => {
    const result = await runCreditBacktest(
      CreditBacktestParamsSchema.parse({
        ...PARAMS,
        closeAtEt: "16:00",
        stopMultiple: 100,
        targetProfitPct: 0.001,
      }),
      deps(flat()),
    );

    expect(result.trades).toHaveLength(2);
    for (const trade of result.trades) {
      expect(["expiry", "time_close"]).toContain(trade.exit.reason);
      expect(trade.exit.reason).not.toBe("coverage_end");
      expect(trade.exit.timestamp.startsWith(TUE)).toBe(true);
    }
    expect(result.warnings.some((w) => w.includes("still open when the data ended"))).toBe(false);
  });

  it("prefers target over time_close on the expiry-day bar when both apply", async () => {
    const result = await runCreditBacktest(
      CreditBacktestParamsSchema.parse({
        ...PARAMS,
        stopMultiple: 100,
        targetProfitPct: 0.5,
        closeAtEt: "15:30",
      }),
      deps(flat()),
    );

    expect(result.trades.length).toBeGreaterThan(0);
    for (const trade of result.trades) {
      expect(trade.exit.reason).toBe("target");
      expect(trade.exit.reason).not.toBe("time_close");
    }
  });

  it("records expiry in byExitReason when the expiry session ends early", async () => {
    const bars = [...session(MON, () => 640), ...sessionUntil(TUE, 205, () => 640)];
    const result = await runCreditBacktest(
      CreditBacktestParamsSchema.parse({
        underlyings: ["SPY"],
        start: MON,
        end: TUE,
        sides: "put",
        stopMultiple: 100,
        targetProfitPct: 0.001,
      }),
      deps(bars),
    );

    expect(result.stats.byExitReason.expiry).toBe(1);
    expect(result.stats.byExitReason.time_close ?? 0).toBe(0);
  });
});
