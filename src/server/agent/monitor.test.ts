import { describe, expect, it, vi } from "vitest";
import type { ManagedSpread } from "@/domain/agent";
import { StrategySignalSchema } from "@/domain/strategy";
import type { OptionQuoteRow } from "@/domain/types";
import type { LlmClient } from "@/server/llm";
import {
  buildCloseSignal,
  classifyZone,
  decideManage,
  markSpread,
  type SpreadMark,
} from "./monitor";

const SPREAD: ManagedSpread = {
  id: "agent-entry-2026-09-01",
  underlying: "SPY",
  kind: "bull_put_spread",
  openedAt: "2026-09-01T14:05:00Z",
  entryEtDate: "2026-09-01",
  shortSymbol: "SPY260902P00500000",
  longSymbol: "SPY260902P00495000",
  shortStrike: 500,
  longStrike: 495,
  width: 5,
  contracts: 2,
  credit: 0.83,
  maxLossPerSpread: 4.17,
  expiration: "2026-09-02",
  targetBuyback: 0.415,
  stopBuyback: 2.49,
  status: "open",
};

function mark(over: Partial<SpreadMark>): Omit<SpreadMark, "zone"> {
  return {
    spread: SPREAD,
    spot: 505,
    shortMid: 0.6,
    longMid: 0.2,
    buyback: 0.4,
    openPnlPerSpread: 0.43,
    pnlPctOfCredit: 0.52,
    distanceToShortPct: 0.01,
    minutesToExpiry: 600,
    minutesToSnapshot: 3000,
    priceable: true,
    ...over,
  };
}

// A time well before the expiry session so `time_close` never fires by accident.
const NOW = new Date("2026-09-01T18:00:00Z");

describe("classifyZone", () => {
  it("forces a close inside the pre-snapshot window", () => {
    expect(classifyZone(mark({ minutesToSnapshot: 30 }), NOW)).toBe("deadline");
  });

  it("stops when the buyback reaches the stop multiple", () => {
    expect(classifyZone(mark({ buyback: 2.5, pnlPctOfCredit: -2 }), NOW)).toBe("stop");
  });

  it("takes profit when the buyback reaches the target", () => {
    expect(classifyZone(mark({ buyback: 0.4 }), NOW)).toBe("profit_target");
  });

  it("fails flat when unpriceable near the short strike", () => {
    expect(
      classifyZone(mark({ priceable: false, buyback: null, distanceToShortPct: 0.005 }), NOW),
    ).toBe("stop");
  });

  it("routes a losing, near-the-strike spread to the dead zone", () => {
    expect(
      classifyZone(
        mark({
          buyback: 1.1,
          pnlPctOfCredit: -0.3,
          distanceToShortPct: 0.005,
          minutesToExpiry: 600,
        }),
        NOW,
      ),
    ).toBe("dead_zone");
  });

  it("routes a losing, low-on-time spread to the dead zone", () => {
    expect(
      classifyZone(
        mark({ buyback: 1.0, pnlPctOfCredit: -0.2, distanceToShortPct: 0.03, minutesToExpiry: 60 }),
        NOW,
      ),
    ).toBe("dead_zone");
  });

  it("holds a comfortable spread", () => {
    expect(
      classifyZone(
        mark({
          buyback: 0.7,
          pnlPctOfCredit: 0.15,
          distanceToShortPct: 0.03,
          minutesToExpiry: 600,
        }),
        NOW,
      ),
    ).toBe("comfortable");
  });
});

describe("markSpread", () => {
  it("computes buyback, P&L and distance from the chain", async () => {
    const snapshots = new Map<string, OptionQuoteRow>([
      [
        SPREAD.shortSymbol,
        {
          symbol: SPREAD.shortSymbol,
          bid: 0.9,
          ask: 1.0,
          mark: 0.95,
          greeks: {},
          updatedAt: NOW.toISOString(),
        } as OptionQuoteRow,
      ],
      [
        SPREAD.longSymbol,
        {
          symbol: SPREAD.longSymbol,
          bid: 0.3,
          ask: 0.4,
          mark: 0.35,
          greeks: {},
          updatedAt: NOW.toISOString(),
        } as OptionQuoteRow,
      ],
    ]);
    const m = await markSpread(
      SPREAD,
      { getOptionSnapshots: async () => snapshots, getSpot: async () => 502 },
      NOW,
    );
    // short mid 0.95, long mid 0.35 -> buyback 0.60
    expect(m.buyback).toBeCloseTo(0.6);
    expect(m.openPnlPerSpread).toBeCloseTo(0.83 - 0.6);
    expect(m.distanceToShortPct).toBeCloseTo((502 - 500) / 502);
    expect(m.priceable).toBe(true);
  });

  it("is not priceable when a leg snapshot is missing", async () => {
    const m = await markSpread(
      SPREAD,
      { getOptionSnapshots: async () => new Map(), getSpot: async () => 505 },
      NOW,
    );
    expect(m.priceable).toBe(false);
    expect(m.buyback).toBeNull();
  });
});

describe("buildCloseSignal", () => {
  it("produces a schema-valid, all-closing mleg signal with a positive limit", () => {
    const signal = buildCloseSignal(SPREAD, "dead_zone/llm", 0.9);
    expect(StrategySignalSchema.safeParse(signal).success).toBe(true);
    expect(signal.entryLimit).toBeCloseTo(0.93);
    expect(signal.resolvedLegs?.every((l) => l.positionIntent.endsWith("_to_close"))).toBe(true);
  });

  it("omits the limit (market close) when the buyback is unknown", () => {
    const signal = buildCloseSignal(SPREAD, "unpriceable/deadline", null);
    expect(signal.entryLimit).toBeUndefined();
  });
});

describe("decideManage fallback", () => {
  const priceableMark: SpreadMark = {
    ...mark({ buyback: 1.1, pnlPctOfCredit: -0.3 }),
    zone: "dead_zone",
  };

  it("holds when the LLM client throws", async () => {
    const llm: LlmClient = {
      model: "fake",
      complete: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    const out = await decideManage(priceableMark, llm, "", 10, NOW);
    expect(out.decision.action).toBe("hold");
  });

  it("holds when the call budget is exhausted", async () => {
    const llm: LlmClient = { model: "fake", complete: vi.fn() };
    const out = await decideManage(priceableMark, llm, "", 0, NOW);
    expect(out.decision.action).toBe("hold");
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it("returns the LLM decision on a clean reply", async () => {
    const llm: LlmClient = {
      model: "fake",
      complete: vi.fn(async () => ({
        content: '{"action":"close","reason":"drift is real","urgency":"high"}',
        model: "fake",
        usage: { inputTokens: 20, outputTokens: 8 },
        latencyMs: 5,
      })),
    };
    const out = await decideManage(priceableMark, llm, "", 10, NOW);
    expect(out.decision.action).toBe("close");
    expect(out.llm?.model).toBe("fake");
  });
});
