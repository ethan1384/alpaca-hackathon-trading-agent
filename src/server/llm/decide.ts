import "server-only";

import type { z } from "zod";
import { type LlmClient, LlmParseError, type LlmUsage } from "./client";

/**
 * Ask the model for one JSON object and validate it against `schema`. One retry
 * on a parse/validation miss (appending the error), then `LlmParseError`.
 * `LlmUnavailableError` from the transport propagates untouched.
 */

export interface DecideResult<T> {
  value: T;
  usage?: LlmUsage;
  latencyMs: number;
  model: string;
  raw: string;
}

export interface DecideOptions<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  temperature?: number;
}

/** Strip a leading/trailing ```json fence some models add. */
export function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

/** Pull the first {...} block out of a reply that also contains prose. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
}

function tryParse<T>(
  raw: string,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; error: string } {
  const candidates = [stripFences(raw), firstJsonObject(stripFences(raw))].filter(
    (c): c is string => c != null && c.length > 0,
  );
  let lastError = "no JSON object in reply";
  for (const candidate of candidates) {
    let json: unknown;
    try {
      json = JSON.parse(candidate);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      continue;
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) {
      return { ok: true, value: parsed.data };
    }
    lastError = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  }
  return { ok: false, error: lastError };
}

export async function decideJson<T>(
  client: LlmClient,
  opts: DecideOptions<T>,
): Promise<DecideResult<T>> {
  const messages = [
    { role: "system" as const, content: opts.system },
    { role: "user" as const, content: opts.user },
  ];

  const first = await client.complete({
    messages,
    temperature: opts.temperature,
    jsonObject: true,
  });
  const firstTry = tryParse(first.content, opts.schema);
  if (firstTry.ok) {
    return {
      value: firstTry.value,
      usage: first.usage,
      latencyMs: first.latencyMs,
      model: first.model,
      raw: first.content,
    };
  }

  const retry = await client.complete({
    messages: [
      ...messages,
      { role: "assistant" as const, content: first.content },
      {
        role: "user" as const,
        content: `Your previous reply was invalid (${firstTry.error}). Respond with ONLY the JSON object, no prose, no code fences.`,
      },
    ],
    temperature: opts.temperature,
    jsonObject: true,
  });
  const secondTry = tryParse(retry.content, opts.schema);
  if (secondTry.ok) {
    return {
      value: secondTry.value,
      usage: retry.usage,
      latencyMs: first.latencyMs + retry.latencyMs,
      model: retry.model,
      raw: retry.content,
    };
  }

  throw new LlmParseError(`LLM reply failed validation after one retry: ${secondTry.error}`);
}
