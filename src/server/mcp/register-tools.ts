import "server-only";

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getCompetitionStatus } from "@/config/competition";
import { TIMEFRAMES } from "@/config/constants";
import { checkPortfolioRisk, RISK } from "@/config/risk";
import { DIRECTIONAL_BIASES, OPTION_STRATEGY_KINDS, StrategySignalSchema } from "@/domain/strategy";
import {
  ClosePositionSchema,
  ListOrdersQuerySchema,
  PlaceOrderSchema,
  POSITION_INTENTS,
  ReplaceOrderSchema,
} from "@/domain/trading";
import type { Timeframe } from "@/domain/types";
import { buildAgentStatus, runAgentCycle } from "@/server/agent";
import { checkCompetitionAccount } from "@/server/alpaca/account-guard";
import { getOptionChain, listOptionExpirations } from "@/server/alpaca/options";
import { getHistoricalBars, getMarketClock } from "@/server/alpaca/rest";
import {
  cancelAllOrders,
  cancelOrder,
  closeAllPositions,
  closePosition,
  getOrder,
  getPosition,
  getTradingAccount,
  listOrders,
  listPositions,
  placeOrder,
  replaceOrder,
} from "@/server/alpaca/trading";
import {
  buildPortfolioExposure,
  describeOrder,
  evaluateKillSwitch,
  getKillSwitchState,
  isRiskEnforced,
  readRecentDecisionsFromDisk,
  recentDecisions,
  reconcilePositions,
  recordManualAction,
  serializeForReview,
  tripKillSwitch,
} from "@/server/risk";
import { executeSignal } from "@/server/strategies";

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Wrap a value as an MCP tool result (JSON text + structured content). */
function ok(value: unknown): ToolResult {
  const structured =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { result: value };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: structured,
  };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

const timeframeSchema = z
  .enum(TIMEFRAMES as unknown as [Timeframe, ...Timeframe[]])
  .default("1Min");

/**
 * Register every trading + market-data tool on an MCP server instance. Shared by
 * the HTTP handler (`/api/mcp`) so the same surface is available to any future
 * transport (stdio, etc.).
 */
export function registerTradingTools(server: McpServer): void {
  // --- Market data / account context -------------------------------------

  server.registerTool(
    "get_clock",
    {
      title: "Market clock",
      description: "Whether the US market is open, plus the next open/close timestamps.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return ok(await getMarketClock());
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_bars",
    {
      title: "Historical bars",
      description:
        "OHLCV history for a stock, crypto (`BTC/USD`), or option (OCC) symbol. Use for analysis before trading.",
      inputSchema: z.object({
        symbol: z.string().min(1),
        timeframe: timeframeSchema,
        limit: z.number().int().min(1).max(1000).default(100),
      }),
    },
    async ({ symbol, timeframe, limit }) => {
      try {
        return ok({ symbol, timeframe, bars: await getHistoricalBars(symbol, timeframe, limit) });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_account",
    {
      title: "Trading account",
      description: "Cash, equity, buying power, margin and account status.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return ok(await getTradingAccount());
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_competition_status",
    {
      title: "Legacy event status",
      description:
        "Compatibility status for the original 2026 event window: phase, time to the historical snapshot, expiration deadline and pinned paper-account check. The personal project retains this tool while the fixed calendar is migrated. See docs/05-legacy-competition.md.",
      inputSchema: z.object({}),
    },
    async () => {
      const competition = getCompetitionStatus();
      try {
        const guard = await checkCompetitionAccount();
        return ok({
          competition,
          account: {
            ok: guard.ok,
            accountNumber: guard.account.accountNumber,
            equity: guard.account.equity,
            optionsTradingLevel: guard.account.optionsTradingLevel,
            violations: guard.violations,
            warnings: guard.warnings,
          },
        });
      } catch (error) {
        // The clock rules stand even when the account lookup fails.
        return ok({
          competition,
          account: { ok: false, error: error instanceof Error ? error.message : String(error) },
        });
      }
    },
  );

  // --- Options ---------------------------------------------------------

  server.registerTool(
    "list_option_expirations",
    {
      title: "List option expirations",
      description: "Available expiration dates (YYYY-MM-DD) for an underlying, next ~90 days.",
      inputSchema: z.object({ underlying: z.string().min(1).max(6) }),
    },
    async ({ underlying }) => {
      try {
        return ok({ underlying, expirations: await listOptionExpirations(underlying) });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_option_chain",
    {
      title: "Option chain",
      description:
        "Enriched option chain (quotes, greeks, IV, OI) for an underlying + expiration, optionally filtered.",
      inputSchema: z.object({
        underlying: z.string().min(1).max(6),
        expiration: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        type: z.enum(["call", "put", "all"]).default("all"),
        strikeGte: z.number().positive().optional(),
        strikeLte: z.number().positive().optional(),
        moneyness: z.number().positive().max(1).optional(),
      }),
    },
    async ({ underlying, ...params }) => {
      try {
        return ok({ underlying, ...(await getOptionChain(underlying, params)) });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "place_option_strategy",
    {
      title: "Place option strategy",
      description:
        "Resolve a directional options thesis into concrete OCC contracts (by target delta / DTE window / liquidity floor) and submit the order. kind: long_call | long_put | bull_call_spread | bear_put_spread | long_straddle | bull_put_spread | bear_call_spread. The credit kinds (bull_put_spread / bear_call_spread) select the short leg by targetDelta and the long wing spreadWidth further OTM; entryLimit there is the net credit to receive. This is the options-native execution path — prefer it over passing raw OCC symbols to place_order.",
      inputSchema: z.object({
        underlying: z.string().min(1).max(6),
        kind: z.enum(OPTION_STRATEGY_KINDS),
        bias: z.enum(DIRECTIONAL_BIASES).optional(),
        maxContracts: z.number().int().positive().default(1),
        entryLimit: z.number().positive().optional(),
        confidence: z.number().min(0).max(1).default(0.5),
        reason: z.string().min(1).default("manual via MCP"),
        targetDelta: z.number().gt(0).lt(1).optional(),
        moneyness: z.number().min(-1).max(1).optional(),
        minDte: z.number().int().min(0).default(7),
        maxDte: z.number().int().min(1).default(45),
        minOpenInterest: z.number().int().min(0).default(0),
        spreadWidth: z.number().positive().optional(),
      }),
      annotations: { destructiveHint: true },
    },
    async (args) => {
      const biasForKind = {
        long_call: "bullish",
        bull_call_spread: "bullish",
        bull_put_spread: "bullish",
        long_put: "bearish",
        bear_put_spread: "bearish",
        bear_call_spread: "bearish",
        long_straddle: "neutral",
      } as const;
      const parsed = StrategySignalSchema.safeParse({
        strategy: "mcp:place_option_strategy",
        underlying: args.underlying,
        bias: args.bias ?? biasForKind[args.kind],
        kind: args.kind,
        selection: {
          targetDelta: args.targetDelta,
          moneyness: args.moneyness,
          minDte: args.minDte,
          maxDte: args.maxDte,
          minOpenInterest: args.minOpenInterest,
          spreadWidth: args.spreadWidth,
        },
        confidence: args.confidence,
        reason: args.reason,
        maxContracts: args.maxContracts,
        entryLimit: args.entryLimit,
        timestamp: new Date().toISOString(),
      });
      if (!parsed.success) {
        return fail(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "));
      }
      try {
        return ok(await executeSignal(parsed.data));
      } catch (error) {
        return fail(error);
      }
    },
  );

  // --- Positions -----------------------------------------------------

  server.registerTool(
    "list_positions",
    {
      title: "List open positions",
      description: "Every open position with quantity, entry price and unrealized P/L.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return ok({ positions: await listPositions() });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_position",
    {
      title: "Get position",
      description: "Details for a single open position by symbol.",
      inputSchema: z.object({ symbol: z.string().min(1) }),
    },
    async ({ symbol }) => {
      try {
        return ok(await getPosition(symbol));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "close_position",
    {
      title: "Close position",
      description:
        "Liquidate a position by symbol. Omit qty/percentage to close it fully. Returns the closing order.",
      inputSchema: z.object({
        symbol: z.string().min(1),
        qty: z.number().positive().optional(),
        percentage: z.number().positive().max(100).optional(),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ symbol, ...rest }) => {
      const parsed = ClosePositionSchema.safeParse(rest);
      if (!parsed.success) {
        return fail(parsed.error.issues.map((i) => i.message).join(", "));
      }
      try {
        const order = await closePosition(symbol, parsed.data);
        await recordManualAction({
          action: "close_position",
          underlying: symbol,
          legs: [symbol],
          reason: "manual close via MCP close_position",
          outcome: { status: "submitted", orderId: order.id },
          source: "mcp",
        });
        return ok(order);
      } catch (error) {
        await recordManualAction({
          action: "close_position",
          underlying: symbol,
          legs: [symbol],
          reason: "manual close via MCP close_position",
          outcome: {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
          source: "mcp",
        });
        return fail(error);
      }
    },
  );

  server.registerTool(
    "close_all_positions",
    {
      title: "Close all positions",
      description:
        "Liquidate every open position. Set cancelOrders to also cancel open orders first.",
      inputSchema: z.object({ cancelOrders: z.boolean().default(false) }),
      annotations: { destructiveHint: true },
    },
    async ({ cancelOrders }) => {
      try {
        const closed = await closeAllPositions(cancelOrders);
        await recordManualAction({
          action: "close_all_positions",
          reason: `liquidate every open position (cancelOrders=${cancelOrders})`,
          outcome: { status: "submitted" },
          source: "mcp",
        });
        return ok({ closed });
      } catch (error) {
        await recordManualAction({
          action: "close_all_positions",
          reason: `liquidate every open position (cancelOrders=${cancelOrders})`,
          outcome: {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
          source: "mcp",
        });
        return fail(error);
      }
    },
  );

  // --- Orders -------------------------------------------------------

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description: "Orders filtered by status (open/closed/all), symbol, side.",
      inputSchema: z.object({
        status: z.enum(["open", "closed", "all"]).default("open"),
        limit: z.number().int().min(1).max(500).default(100),
        symbols: z.array(z.string()).optional(),
        side: z.enum(["buy", "sell"]).optional(),
        nested: z.boolean().optional(),
      }),
    },
    async (args) => {
      const parsed = ListOrdersQuerySchema.safeParse({
        ...args,
        symbols: args.symbols?.join(","),
      });
      if (!parsed.success) {
        return fail(parsed.error.issues.map((i) => i.message).join(", "));
      }
      try {
        return ok({ orders: await listOrders(parsed.data) });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: "A single order by its ID, including bracket/OCO legs.",
      inputSchema: z.object({ orderId: z.string().min(1) }),
    },
    async ({ orderId }) => {
      try {
        return ok(await getOrder(orderId));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "place_order",
    {
      title: "Place order",
      description:
        "Submit an order. type: market|limit|stop|stop_limit|trailing_stop. Add takeProfit and/or stopLoss to make it a bracket/OTO/OCO. Provide exactly one of qty or notional. For a multi-leg option spread, pass `legs` (2-4 OCC symbols on one underlying) instead of symbol/side — order class `mleg` is derived. For single option legs, set `positionIntent` (buy_to_open / sell_to_close / …).",
      inputSchema: z.object({
        symbol: z.string().min(1).optional(),
        side: z.enum(["buy", "sell"]).optional(),
        type: z.enum(["market", "limit", "stop", "stop_limit", "trailing_stop"]).default("market"),
        timeInForce: z.enum(["day", "gtc", "opg", "cls", "ioc", "fok"]).default("day"),
        qty: z.number().positive().optional(),
        notional: z.number().positive().optional(),
        limitPrice: z.number().positive().optional(),
        stopPrice: z.number().positive().optional(),
        trailPrice: z.number().positive().optional(),
        trailPercent: z.number().positive().optional(),
        extendedHours: z.boolean().optional(),
        clientOrderId: z.string().min(1).max(128).optional(),
        positionIntent: z.enum(POSITION_INTENTS).optional(),
        takeProfit: z.object({ limitPrice: z.number().positive() }).optional(),
        stopLoss: z
          .object({
            stopPrice: z.number().positive(),
            limitPrice: z.number().positive().optional(),
          })
          .optional(),
        legs: z
          .array(
            z.object({
              symbol: z.string().min(1),
              side: z.enum(["buy", "sell"]),
              ratioQty: z.number().int().positive().default(1),
              positionIntent: z.enum(POSITION_INTENTS),
            }),
          )
          .min(2)
          .max(4)
          .optional(),
      }),
      annotations: { destructiveHint: true },
    },
    async (args) => {
      const parsed = PlaceOrderSchema.safeParse(args);
      if (!parsed.success) {
        return fail(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "));
      }
      const described = describeOrder(parsed.data);
      try {
        const order = await placeOrder(parsed.data);
        await recordManualAction({
          action: "place_order",
          ...described,
          reason: "raw order via MCP place_order",
          outcome: { status: "submitted", orderId: order.id },
          source: "mcp",
        });
        return ok(order);
      } catch (error) {
        await recordManualAction({
          action: "place_order",
          ...described,
          reason: "raw order via MCP place_order",
          outcome: {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
          source: "mcp",
        });
        return fail(error);
      }
    },
  );

  server.registerTool(
    "replace_order",
    {
      title: "Replace order",
      description:
        "Modify an open order in place (qty, limitPrice, stopPrice, trail, timeInForce). Use this to move a take-profit or stop-loss.",
      inputSchema: z.object({
        orderId: z.string().min(1),
        qty: z.number().positive().optional(),
        limitPrice: z.number().positive().optional(),
        stopPrice: z.number().positive().optional(),
        trail: z.number().positive().optional(),
        timeInForce: z.enum(["day", "gtc", "opg", "cls", "ioc", "fok"]).optional(),
      }),
    },
    async ({ orderId, ...rest }) => {
      const parsed = ReplaceOrderSchema.safeParse(rest);
      if (!parsed.success) {
        return fail(parsed.error.issues.map((i) => i.message).join(", "));
      }
      try {
        const order = await replaceOrder(orderId, parsed.data);
        await recordManualAction({
          action: "replace_order",
          reason: `replace ${orderId}: ${JSON.stringify(parsed.data)}`,
          outcome: { status: "submitted", orderId: order.id },
          source: "mcp",
        });
        return ok(order);
      } catch (error) {
        await recordManualAction({
          action: "replace_order",
          reason: `replace ${orderId}`,
          outcome: {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
          source: "mcp",
        });
        return fail(error);
      }
    },
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel order",
      description: "Cancel a single open order by ID.",
      inputSchema: z.object({ orderId: z.string().min(1) }),
      annotations: { destructiveHint: true },
    },
    async ({ orderId }) => {
      try {
        await cancelOrder(orderId);
        await recordManualAction({
          action: "cancel_order",
          reason: `cancel ${orderId}`,
          outcome: { status: "submitted", orderId },
          source: "mcp",
        });
        return ok({ ok: true, orderId });
      } catch (error) {
        await recordManualAction({
          action: "cancel_order",
          reason: `cancel ${orderId}`,
          outcome: {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
          source: "mcp",
        });
        return fail(error);
      }
    },
  );

  server.registerTool(
    "cancel_all_orders",
    {
      title: "Cancel all orders",
      description: "Cancel every open order.",
      inputSchema: z.object({}),
      annotations: { destructiveHint: true },
    },
    async () => {
      try {
        const canceled = await cancelAllOrders();
        await recordManualAction({
          action: "cancel_all_orders",
          reason: "cancel every open order",
          outcome: { status: "submitted" },
          source: "mcp",
        });
        return ok({ canceled });
      } catch (error) {
        await recordManualAction({
          action: "cancel_all_orders",
          reason: "cancel every open order",
          outcome: {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
          source: "mcp",
        });
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_risk_status",
    {
      title: "Portfolio & operational risk status",
      description:
        "The account's current risk state: net dollar-delta and net vega, buying power used, open positions per sector, the kill-switch state, and which of the [K1]-[K6] caps the book currently breaches. Also reruns the kill-switch drawdown reading. Call this before sizing anything — the caps are enforced at execution, so discovering a breach here is cheaper than discovering it as a rejected order. Parameters: docs/06-options-parameters.md.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const exposure = await buildPortfolioExposure();
        const verdict = checkPortfolioRisk(exposure);
        const killSwitch = await evaluateKillSwitch().catch(() => getKillSwitchState());
        return ok({ enforced: isRiskEnforced(), caps: RISK, exposure, verdict, killSwitch });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "reconcile_positions",
    {
      title: "Reconcile positions",
      description:
        "[O6] Compare the agent's expected book against the account's real one. Pass the positions the agent believes it holds as { OCC symbol: signed contract count } (negative = short); pass {} on a cold start to list every unmanaged position. The account is always the source of truth — this reports the drift, it does not resolve it.",
      inputSchema: z.object({
        expected: z
          .record(z.string(), z.number())
          .default({})
          .describe("OCC symbol -> signed contracts the agent believes it holds"),
      }),
    },
    async ({ expected }) => {
      try {
        return ok(await reconcilePositions(expected));
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_decision_log",
    {
      title: "Agent decision log",
      description:
        '[O5] Recent agent decisions: what triggered each evaluation, the structure chosen, the alternatives rejected and why, the guardrail verdicts, the sizing, and the outcome. `format: "review"` returns the compact one-line-per-decision form meant to be handed to a reviewing model.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(50),
        format: z.enum(["json", "review"]).default("json"),
      }),
    },
    async ({ limit, format }) => {
      const ring = recentDecisions(limit);
      const records = ring.length > 0 ? ring : await readRecentDecisionsFromDisk(limit);
      return format === "review" ? ok({ review: serializeForReview(records) }) : ok({ records });
    },
  );

  server.registerTool(
    "trip_kill_switch",
    {
      title: "Trip the kill switch",
      description:
        "[O1] Emergency stop: cancel every open order, close every position, and halt the agent until it is manually re-armed. Irreversible from the agent's side by design — re-arming is a human action. Use for the pre-start drill and for a real emergency.",
      inputSchema: z.object({
        reason: z.string().min(1).describe("Why the switch is being tripped — recorded in state"),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ reason }) => {
      try {
        return ok(await tripKillSwitch(reason));
      } catch (error) {
        return fail(error);
      }
    },
  );

  // --- LLM decision agent -------------------------------------------

  server.registerTool(
    "run_agent_cycle",
    {
      title: "Run one agent cycle",
      description:
        "Runs a single cycle of the LLM decision agent (docs/08-agent.md): manage every open credit spread (mechanical exits in code, the LLM only in the dead zone), then — inside the daily entry window — build a put-credit-spread candidate and put it to the LLM for a veto. Places real paper orders. Gated only by AGENT_ENABLED / COMPETITION_ENFORCE / RISK_ENFORCE.",
      inputSchema: z.object({}),
      annotations: { destructiveHint: true },
    },
    async () => {
      try {
        return ok(await runAgentCycle());
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_agent_status",
    {
      title: "Agent status",
      description:
        "Read-only: the agent's calibration, the competition phase, the account check, a dump of the working-memory file, and the open agent spreads. `withMarks: true` also prices each open spread.",
      inputSchema: z.object({ withMarks: z.boolean().default(false) }),
    },
    async ({ withMarks }) => {
      try {
        return ok(await buildAgentStatus({ withMarks }));
      } catch (error) {
        return fail(error);
      }
    },
  );
}
