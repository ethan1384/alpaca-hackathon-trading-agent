import { describe, expect, it, vi } from "vitest";
import { StrategySignalSchema } from "@/domain/strategy";
import { buildOptionSymbol, type OptionQuoteRow } from "@/domain/types";
import { resolveContracts, type SelectContractDeps } from "./select-contract";

const UNDERLYING = "SPY";
const EXPIRATION = "2026-09-18";
const NOW = new Date("2026-08-28T00:00:00Z"); // ~21 DTE to EXPIRATION

function row(
  strike: number,
  type: "call" | "put",
  delta: number,
  openInterest: number,
): OptionQuoteRow {
  const mark = 5;
  return {
    symbol: buildOptionSymbol({ underlying: UNDERLYING, expiration: EXPIRATION, type, strike }),
    underlying: UNDERLYING,
    expiration: EXPIRATION,
    type,
    strike,
    bid: mark - 0.1,
    ask: mark + 0.1,
    mark,
    openInterest,
    greeks: { delta },
  };
}

const CALLS: OptionQuoteRow[] = [
  row(490, "call", 0.68, 5000),
  row(495, "call", 0.58, 5000),
  row(500, "call", 0.5, 5000),
  row(505, "call", 0.4, 5000),
  row(510, "call", 0.3, 5000),
  row(515, "call", 0.2, 5000),
];

function makeDeps(rows: OptionQuoteRow[], expirations = [EXPIRATION]): SelectContractDeps {
  return {
    listOptionExpirations: vi.fn(async () => ["2026-08-30", ...expirations, "2027-03-19"]),
    getOptionChain: vi.fn(async () => ({ spot: 500, rows })),
  };
}

function signal(overrides: Record<string, unknown>) {
  return StrategySignalSchema.parse({
    strategy: "test",
    underlying: UNDERLYING,
    bias: "bullish",
    kind: "long_call",
    selection: { minDte: 7, maxDte: 45 },
    confidence: 0.7,
    reason: "test",
    timestamp: NOW.toISOString(),
    ...overrides,
  });
}

describe("resolveContracts", () => {
  it("picks the call closest to the target delta", async () => {
    const deps = makeDeps(CALLS);
    const legs = await resolveContracts(
      signal({ selection: { minDte: 7, maxDte: 45, targetDelta: 0.4 } }),
      deps,
      NOW,
    );
    expect(legs).toHaveLength(1);
    expect(legs[0].symbol).toBe(CALLS[3].symbol); // strike 505, delta 0.40
    expect(legs[0].positionIntent).toBe("buy_to_open");
  });

  it("queries the expiration inside the DTE window", async () => {
    const deps = makeDeps(CALLS);
    await resolveContracts(signal({}), deps, NOW);
    expect(deps.getOptionChain).toHaveBeenCalledWith(
      UNDERLYING,
      expect.objectContaining({ expiration: EXPIRATION }),
    );
  });

  it("returns [] when no expiration falls in the window", async () => {
    const deps = makeDeps(CALLS, []);
    const legs = await resolveContracts(
      signal({ selection: { minDte: 400, maxDte: 500 } }),
      deps,
      NOW,
    );
    expect(legs).toEqual([]);
  });

  it("drops contracts below the open-interest floor", async () => {
    const rows = [row(500, "call", 0.5, 10), row(505, "call", 0.4, 9000)];
    const deps = makeDeps(rows);
    const legs = await resolveContracts(
      signal({ selection: { minDte: 7, maxDte: 45, targetDelta: 0.5, minOpenInterest: 1000 } }),
      deps,
      NOW,
    );
    expect(legs).toHaveLength(1);
    expect(legs[0].symbol).toBe(rows[1].symbol); // the illiquid 0.50 strike is filtered out
  });

  it("builds a bull call spread with the short leg one width above the long", async () => {
    const deps = makeDeps(CALLS);
    const legs = await resolveContracts(
      signal({
        kind: "bull_call_spread",
        selection: { minDte: 7, maxDte: 45, targetDelta: 0.5, spreadWidth: 10 },
      }),
      deps,
      NOW,
    );
    expect(legs).toHaveLength(2);
    expect(legs[0].side).toBe("buy");
    expect(legs[1].side).toBe("sell");
    const long = legs[0].symbol;
    const short = legs[1].symbol;
    expect(long).toBe(
      buildOptionSymbol({
        underlying: UNDERLYING,
        expiration: EXPIRATION,
        type: "call",
        strike: 500,
      }),
    );
    expect(short).toBe(
      buildOptionSymbol({
        underlying: UNDERLYING,
        expiration: EXPIRATION,
        type: "call",
        strike: 510,
      }),
    );
  });

  const PUTS: OptionQuoteRow[] = [
    row(480, "put", 0.1, 5000),
    row(485, "put", 0.15, 5000),
    row(490, "put", 0.2, 5000),
    row(495, "put", 0.32, 5000),
    row(500, "put", 0.5, 5000),
  ];

  it("builds a bull put spread: short leg by delta, long wing one width lower", async () => {
    const deps = makeDeps(PUTS);
    const legs = await resolveContracts(
      signal({
        kind: "bull_put_spread",
        bias: "bullish",
        selection: { minDte: 7, maxDte: 45, targetDelta: 0.2, spreadWidth: 5 },
      }),
      deps,
      NOW,
    );
    expect(legs).toHaveLength(2);
    const [short, long] = legs;
    expect(short.side).toBe("sell");
    expect(short.positionIntent).toBe("sell_to_open");
    expect(short.symbol).toBe(
      buildOptionSymbol({
        underlying: UNDERLYING,
        expiration: EXPIRATION,
        type: "put",
        strike: 490,
      }),
    );
    expect(long.side).toBe("buy");
    expect(long.symbol).toBe(
      buildOptionSymbol({
        underlying: UNDERLYING,
        expiration: EXPIRATION,
        type: "put",
        strike: 485,
      }),
    );
  });

  it("bull put spread resolves to a schema-valid signal", async () => {
    const deps = makeDeps(PUTS);
    const legs = await resolveContracts(
      signal({
        kind: "bull_put_spread",
        bias: "bullish",
        selection: { minDte: 7, maxDte: 45, targetDelta: 0.2, spreadWidth: 5 },
      }),
      deps,
      NOW,
    );
    const validated = StrategySignalSchema.safeParse({
      strategy: "test",
      underlying: UNDERLYING,
      bias: "bullish",
      kind: "bull_put_spread",
      selection: { minDte: 7, maxDte: 45 },
      confidence: 0.7,
      reason: "test",
      timestamp: NOW.toISOString(),
      resolvedLegs: legs,
    });
    expect(validated.success).toBe(true);
  });

  it("never lets a row with no delta outrank one that has it", async () => {
    // The ITM 505 put carries no greek. Scored on moneyness it looks perfect
    // (1% from ATM) and beats the 490 the target delta actually asks for — which
    // is how "sell the 0.2-delta put" once resolved to selling 5 points ITM.
    const rows = [
      row(505, "put", 0, 5000),
      row(490, "put", -0.2, 5000),
      row(485, "put", -0.15, 5000),
    ];
    rows[0].greeks = undefined;
    const legs = await resolveContracts(
      signal({
        kind: "bull_put_spread",
        selection: { minDte: 7, maxDte: 45, targetDelta: 0.2, spreadWidth: 5 },
      }),
      makeDeps(rows),
      NOW,
    );

    expect(legs).toHaveLength(2);
    expect(legs[0].symbol).toBe(rows[1].symbol); // 490, by delta — not the ITM 505
  });

  it("never resolves a wing wider than the requested width", async () => {
    // The 5-wide wing (485) is illiquid; 480 is. Taking 480 would turn a 5-point
    // spread into a 10-point one — twice the max loss for the same credit.
    const rows = [
      row(500, "put", -0.5, 5000),
      row(490, "put", -0.2, 5000),
      row(487, "put", -0.17, 5000),
      row(485, "put", -0.15, 10),
      row(480, "put", -0.1, 5000),
    ];
    const legs = await resolveContracts(
      signal({
        kind: "bull_put_spread",
        selection: {
          minDte: 7,
          maxDte: 45,
          targetDelta: 0.2,
          spreadWidth: 5,
          minOpenInterest: 500,
        },
      }),
      makeDeps(rows),
      NOW,
    );

    expect(legs).toHaveLength(2);
    expect(legs[0].symbol).toBe(rows[1].symbol); // short 490 by delta
    // Falls inward to 487, never outward to 480.
    expect(legs[1].symbol).toBe(rows[2].symbol);
  });

  it("builds a bear call spread: short leg by delta, long wing one width higher", async () => {
    const deps = makeDeps(CALLS);
    const legs = await resolveContracts(
      signal({
        kind: "bear_call_spread",
        bias: "bearish",
        selection: { minDte: 7, maxDte: 45, targetDelta: 0.3, spreadWidth: 5 },
      }),
      deps,
      NOW,
    );
    expect(legs).toHaveLength(2);
    const [short, long] = legs;
    expect(short.side).toBe("sell");
    expect(short.symbol).toBe(
      buildOptionSymbol({
        underlying: UNDERLYING,
        expiration: EXPIRATION,
        type: "call",
        strike: 510,
      }),
    );
    expect(long.side).toBe("buy");
    expect(long.symbol).toBe(
      buildOptionSymbol({
        underlying: UNDERLYING,
        expiration: EXPIRATION,
        type: "call",
        strike: 515,
      }),
    );
  });

  it("returns [] when the credit-spread short strike is illiquid", async () => {
    const rows = [row(490, "put", 0.2, 10), row(485, "put", 0.15, 9000)];
    const deps = makeDeps(rows);
    const legs = await resolveContracts(
      signal({
        kind: "bull_put_spread",
        bias: "bullish",
        selection: {
          minDte: 7,
          maxDte: 45,
          targetDelta: 0.2,
          spreadWidth: 5,
          minOpenInterest: 1000,
        },
      }),
      deps,
      NOW,
    );
    // Only the 485 wing clears the OI floor; no distinct short leg -> no trade.
    expect(legs).toEqual([]);
  });

  it("resolves a signal that passes StrategySignalSchema end to end", async () => {
    const deps = makeDeps(CALLS);
    const legs = await resolveContracts(
      signal({ selection: { minDte: 7, maxDte: 45, targetDelta: 0.3 } }),
      deps,
      NOW,
    );
    const validated = StrategySignalSchema.safeParse({
      strategy: "test",
      underlying: UNDERLYING,
      bias: "bullish",
      kind: "long_call",
      selection: { minDte: 7, maxDte: 45 },
      confidence: 0.7,
      reason: "test",
      timestamp: NOW.toISOString(),
      resolvedLegs: legs,
    });
    expect(validated.success).toBe(true);
  });
});
