import { describe, expect, it } from "vitest";
import { buildEntryUserPrompt, type EntryPromptContext } from "./prompt";

const base: EntryPromptContext = {
  todayEt: "2026-09-01",
  phase: "scoring",
  hoursUntilSnapshot: 50.5,
  optionDeadline: "2026-09-03",
  spot: 641.2,
  realisedVol: 0.12,
  shortIv: 0.138,
  recentCloses: [635.1, 637.44, 639.02, 640.88, 641.2],
  shortStrike: 634,
  longStrike: 629,
  width: 5,
  dte: 2,
  expiration: "2026-09-03",
  midCredit: 0.72,
  entryLimit: 0.7,
  creditRatio: 0.14,
  shortDelta: 0.17,
  contracts: 2,
  maxLossUsd: 860,
  pctOfEquity: 0.0086,
  recentDecisions: "",
  notes: "",
};

describe("buildEntryUserPrompt", () => {
  it("renders the closes the trend criterion needs", () => {
    const out = buildEntryUserPrompt(base);
    expect(out).toContain("635.10, 637.44, 639.02, 640.88, 641.20");
    expect(out).not.toContain("closes (oldest first): \n");
  });

  it("renders implied vol and the IV/RV ratio the veto rule is stated in", () => {
    const out = buildEntryUserPrompt(base);
    expect(out).toContain("Short-leg implied vol: 13.8%");
    expect(out).toContain("IV/RV: 1.15");
  });

  it("says `unavailable` rather than an empty list when history is missing", () => {
    const out = buildEntryUserPrompt({ ...base, recentCloses: [] });
    expect(out).toContain("in progress): unavailable");
  });

  it("says `unknown` when the feed omits a volatility", () => {
    const out = buildEntryUserPrompt({ ...base, shortIv: null, realisedVol: null });
    expect(out).toContain("Short-leg implied vol: unknown");
    expect(out).toContain("IV/RV: unknown");
  });

  it("does not divide by a zero realised vol", () => {
    expect(buildEntryUserPrompt({ ...base, realisedVol: 0 })).toContain("IV/RV: unknown");
  });
});
