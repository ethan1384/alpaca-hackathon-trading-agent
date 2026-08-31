import "server-only";

import { AGENT } from "@/config/agent";
import { easternDate, getCompetitionStatus } from "@/config/competition";
import { getEnv } from "@/config/env";
import type { AgentStatus, SpreadMarkSummary } from "@/domain/agent";
import { checkCompetitionAccount } from "@/server/alpaca/account-guard";
import { markSpread } from "./monitor";
import { loadAgentState, serializeAgentState } from "./positions-store";

/** The payload behind `GET /api/agent/status` and the MCP `get_agent_status` tool. */
export async function buildAgentStatus(
  { withMarks = false }: { withMarks?: boolean } = {},
  now: Date = new Date(),
): Promise<AgentStatus> {
  const env = getEnv();
  const state = await loadAgentState();

  const accountCheck = await checkCompetitionAccount().catch(() => null);
  const openSpreads = state.spreads.filter((s) => s.status === "open");

  let marks: SpreadMarkSummary[] | undefined;
  if (withMarks && openSpreads.length > 0) {
    marks = await Promise.all(
      openSpreads.map(async (spread) => {
        const m = await markSpread(spread, {}, now).catch(() => null);
        return {
          id: spread.id,
          spot: m?.spot ?? null,
          buyback: m?.buyback ?? null,
          openPnlPerSpread: m?.openPnlPerSpread ?? null,
          pnlPctOfCredit: m?.pnlPctOfCredit ?? null,
          distanceToShortPct: m?.distanceToShortPct ?? null,
          minutesToExpiry: m?.minutesToExpiry ?? 0,
          minutesToSnapshot: m?.minutesToSnapshot ?? 0,
          priceable: m?.priceable ?? false,
          zone: m?.zone ?? "comfortable",
        } satisfies SpreadMarkSummary;
      }),
    );
  }

  return {
    enabled: env.AGENT_ENABLED,
    llm: { model: env.AGENT_LLM_MODEL, baseUrl: env.AGENT_LLM_BASE_URL },
    config: AGENT,
    competition: getCompetitionStatus(now),
    account: {
      ok: accountCheck?.ok ?? false,
      number: accountCheck?.account.accountNumber,
      equity: accountCheck?.account.equity ?? 0,
      optionsLevel: accountCheck?.account.optionsTradingLevel,
      violations: accountCheck?.violations ?? ["account unreadable"],
      warnings: accountCheck?.warnings ?? [],
    },
    state: serializeAgentState(state),
    enteredToday: state.enteredEtDates.includes(easternDate(now)),
    spreads: openSpreads,
    marks,
  };
}
