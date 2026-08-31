import { z } from "zod";
import { parseDefaultSymbols } from "./constants";

const envSchema = z.object({
  ALPACA_API_KEY: z.string().min(1, "ALPACA_API_KEY is required"),
  ALPACA_API_SECRET: z.string().min(1, "ALPACA_API_SECRET is required"),
  ALPACA_PAPER: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  ALPACA_DATA_FEED: z.enum(["test", "iex", "sip"]).default("test"),
  MARKET_BUFFER_SIZE: z.coerce.number().int().min(10).max(1000).default(200),
  NEXT_PUBLIC_DEFAULT_SYMBOLS: z.string().default("AAPL,TSLA,SPY"),
  /**
   * When set, the MCP endpoint (`/api/mcp`) requires
   * `Authorization: Bearer <token>`. Leave empty to allow unauthenticated
   * access (fine for local paper-trading only).
   */
  MCP_AUTH_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  /**
   * Competition mode. When `true`, the hackathon guardrails
   * (`src/server/strategies/guardrails.ts`) throw instead of warning: opening
   * trades are refused outside the scored window and option legs expiring past
   * the judged snapshot are rejected. See `docs/05-hackathon-rules.md`.
   *
   * The official run sets this to `true`; development leaves it off.
   */
  COMPETITION_ENFORCE: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  /**
   * Account number of the official competition paper account ([R1]/[R2]). When
   * set, `assertCompetitionAccount()` refuses to trade any other account, so a
   * stale `.env` pointing at the testing account cannot corrupt the measured
   * P&L. Leave empty during development.
   */
  COMPETITION_ACCOUNT_NUMBER: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined)),
  /**
   * Risk mode. When `true`, the portfolio and operational guardrails
   * (`src/server/risk/`) run before every opening order and throw on a breach:
   * kill switch, execution-time window, data circuit breaker, and the [K1]-[K6]
   * portfolio caps. See `docs/06-options-parameters.md`.
   *
   * Off by default for the same reason as `COMPETITION_ENFORCE`: the checks
   * need a live account and a live chain, and must not be why an unrelated test
   * or backtest fails. **The official run sets this to `true`.**
   */
  RISK_ENFORCE: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  /**
   * Where the structured decision log [O5] and the agent working-memory file
   * (`agent-state.json`) are written. Appended to / rewritten in place; meant to
   * be readable by a judge and by a reviewing model without post-processing.
   */
  AGENT_LOG_DIR: z.string().default(".agent"),
  /**
   * Where agent working memory and the [O5] decision log are persisted.
   * `filesystem` writes under `AGENT_LOG_DIR` (local dev). `blob` uses Vercel
   * Blob (`BLOB_READ_WRITE_TOKEN`) — required on serverless hosts.
   */
  AGENT_STORAGE: z.enum(["filesystem", "blob"]).default("filesystem"),
  /** Vercel Blob read-write token. Injected when a Blob store is linked to the project. */
  BLOB_READ_WRITE_TOKEN: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  /**
   * LLM decision agent (`src/server/agent/`, docs/08-agent.md). The client is a
   * plain OpenAI-compatible `POST {base}/chat/completions` — point it at a local
   * Ollama (`http://localhost:11434/v1`), Featherless
   * (`https://api.featherless.ai/v1`), or any compatible endpoint. Calibration
   * (thresholds, sizing, timings) lives in `src/config/agent.ts`, not here.
   */
  AGENT_LLM_BASE_URL: z.string().url().default("http://localhost:11434/v1"),
  /** The served model id. Set this to whatever you pulled, e.g. `qwen3:30b`. */
  AGENT_LLM_MODEL: z.string().min(1).default("qwen3:8b"),
  /** Bearer token for the LLM endpoint. Omit for a local Ollama. */
  AGENT_LLM_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  AGENT_LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  /**
   * Completion-token budget per LLM call.
   *
   * Must be generous enough for a *reasoning* model. Ollama serves qwen3's
   * chain-of-thought out of the completion budget and returns it in a separate
   * `reasoning` field, so a small cap is spent entirely on thinking and
   * `content` comes back empty with `finish_reason: "length"` — which the agent
   * reads as "LLM unavailable" and fail-safes into vetoing every entry. 700 did
   * exactly that with qwen3:14b; the answer itself only needs ~150.
   */
  AGENT_LLM_MAX_TOKENS: z.coerce.number().int().min(256).max(32_000).default(4_096),
  /**
   * Hard on/off for `POST /api/agent/run`. When `false` the route returns 503
   * and no cycle runs — the kill switch of last resort. Defaults on.
   */
  AGENT_ENABLED: z
    .string()
    .optional()
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  /**
   * DEV ONLY. Overrides the clock the agent cycle runs against, so you can test
   * the entry path before the scoring window opens (or after the snapshot). The
   * whole simulation — scoring phase, daily entry window, DTE deadline — is
   * resolved from this instant, so pick something inside all of them, e.g.
   * `2026-09-02T14:30:00Z` (Tue 10:30 ET). Must be a parseable ISO datetime.
   *
   * `POST /api/agent/run` refuses to honour it when `COMPETITION_ENFORCE=true`,
   * so it can never taint the official run. Leave empty in production.
   */
  AGENT_CLOCK_OVERRIDE: z
    .string()
    .optional()
    .transform((v) => (v && v.trim().length > 0 ? v.trim() : undefined))
    .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), {
      message: "AGENT_CLOCK_OVERRIDE must be a parseable ISO datetime",
    }),
});

export type Env = z.infer<typeof envSchema> & {
  defaultSymbols: string[];
};

let cachedEnv: Env | null = null;

export function getEnv(): Env {
  if (cachedEnv) {
    return cachedEnv;
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${message}`);
  }

  cachedEnv = {
    ...parsed.data,
    defaultSymbols: parseDefaultSymbols(parsed.data.NEXT_PUBLIC_DEFAULT_SYMBOLS),
  };

  return cachedEnv;
}

export function resetEnvCache(): void {
  cachedEnv = null;
}
