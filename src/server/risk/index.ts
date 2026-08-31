import "server-only";

/**
 * The risk & operations layer — [K1]-[K6] and [O1]-[O6] of
 * `docs/06-options-parameters.md`.
 *
 * Parameters and the pure predicates live in `src/config/risk.ts` (importable
 * from anywhere, fully unit-testable). This directory holds the parts that need
 * an account, a clock, or process state.
 */

export {
  clearDecisionRing,
  type DecisionDraft,
  type DecisionRecord,
  describeOrder,
  readRecentDecisionsFromDisk,
  recentDecisions,
  recordDecision,
  recordManualAction,
  serializeForReview,
} from "./decision-log";
export { buildPortfolioExposure, type ExposureDeps, priceCandidate } from "./exposure";
export {
  assertTradeAllowed,
  checkTrade,
  isRiskEnforced,
  type RiskGateDeps,
  type RiskGateResult,
} from "./gate";
export {
  evaluateKillSwitch,
  getKillSwitchState,
  isHalted,
  type KillSwitchState,
  rearmKillSwitch,
  tripKillSwitch,
} from "./kill-switch";
export {
  type ReconciliationReport,
  reconcilePositions,
} from "./reconcile";
