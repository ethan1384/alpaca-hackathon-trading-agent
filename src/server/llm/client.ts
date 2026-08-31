import "server-only";

import { getEnv } from "@/config/env";

/**
 * Provider-agnostic LLM client: a plain `POST {baseUrl}/chat/completions` in the
 * OpenAI shape. Works unchanged against a local Ollama (`/v1`), Featherless,
 * OpenAI, Together, vLLM, and anything else that speaks the same protocol — so
 * there is deliberately no SDK dependency.
 *
 * The agent treats any failure here as "no entry / hold" (see
 * `src/server/agent/run-cycle.ts`), so this module only needs to fail loudly and
 * quickly, never to retry the transport.
 */

/** Fallback budget when neither the request nor the client config sets one. */
const DEFAULT_MAX_TOKENS = 4_096;

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Ask the endpoint for a JSON object (`response_format`). */
  jsonObject?: boolean;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface LlmResult {
  content: string;
  model: string;
  usage?: LlmUsage;
  latencyMs: number;
  /**
   * The model's chain-of-thought, when the endpoint returns it out of band
   * (Ollama and vLLM both expose `message.reasoning` for qwen3-class models).
   * Never parsed for the decision — kept only so the [O5] log can show what the
   * model was thinking when it answered.
   */
  reasoning?: string;
}

export interface LlmClient {
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResult>;
}

/** Network failure, timeout, or a non-2xx response. */
export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

/** The reply could not be parsed into the expected schema, even after a retry. */
export class LlmParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmParseError";
  }
}

export interface LlmClientConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  /** Completion-token budget. See `AGENT_LLM_MAX_TOKENS` in `src/config/env.ts`. */
  maxTokens?: number;
}

interface ChatCompletionResponse {
  choices?: {
    message?: { content?: string; reasoning?: string; reasoning_content?: string };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Some endpoints inline the chain-of-thought in `content` instead of returning
 * it separately. Strip it, including the unterminated tail a truncated reply
 * leaves behind, so the JSON parser only ever sees the answer.
 */
export function stripReasoning(text: string): string {
  return text
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(think|thinking|reasoning)>[\s\S]*$/i, "")
    .trim();
}

export function createLlmClient(cfg: LlmClientConfig): LlmClient {
  const endpoint = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    model: cfg.model,
    async complete(req: LlmRequest): Promise<LlmResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      const startedAt = Date.now();

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: cfg.model,
            messages: req.messages,
            temperature: req.temperature ?? 0.2,
            max_tokens: req.maxTokens ?? cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
            ...(req.jsonObject ? { response_format: { type: "json_object" } } : {}),
          }),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new LlmUnavailableError(
          controller.signal.aborted
            ? `LLM request timed out after ${cfg.timeoutMs}ms (${endpoint})`
            : `LLM request failed: ${reason} (${endpoint})`,
        );
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new LlmUnavailableError(
          `LLM endpoint returned ${response.status} ${response.statusText}: ${body.slice(0, 200)}`,
        );
      }

      let json: ChatCompletionResponse;
      try {
        json = (await response.json()) as ChatCompletionResponse;
      } catch (error) {
        throw new LlmUnavailableError(
          `LLM response was not JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const choice = json.choices?.[0];
      const reasoning = choice?.message?.reasoning ?? choice?.message?.reasoning_content;
      const content = stripReasoning(choice?.message?.content ?? "");

      if (content.length === 0) {
        // The single most likely cause, and the one that silently disabled the
        // agent: a reasoning model spent the whole completion budget thinking.
        // Say so, so the decision log names the fix instead of "unavailable".
        const spent = json.usage?.completion_tokens;
        throw new LlmUnavailableError(
          choice?.finish_reason === "length"
            ? `LLM answer was truncated before it produced any content (finish_reason=length, ${spent ?? "?"} completion tokens spent, likely all on reasoning) — raise AGENT_LLM_MAX_TOKENS`
            : "LLM response contained no message content",
        );
      }

      return {
        content,
        model: cfg.model,
        usage: {
          inputTokens: json.usage?.prompt_tokens,
          outputTokens: json.usage?.completion_tokens,
        },
        latencyMs: Date.now() - startedAt,
        ...(reasoning ? { reasoning } : {}),
      };
    },
  };
}

let cached: LlmClient | null = null;

/** The process-wide client, configured from `getEnv()`. */
export function getLlmClient(): LlmClient {
  if (cached) {
    return cached;
  }
  const env = getEnv();
  cached = createLlmClient({
    baseUrl: env.AGENT_LLM_BASE_URL,
    model: env.AGENT_LLM_MODEL,
    apiKey: env.AGENT_LLM_API_KEY,
    timeoutMs: env.AGENT_LLM_TIMEOUT_MS,
    maxTokens: env.AGENT_LLM_MAX_TOKENS,
  });
  return cached;
}

/** Test hook. */
export function resetLlmClientCache(): void {
  cached = null;
}
