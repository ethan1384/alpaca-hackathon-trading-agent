import { describe, expect, it, vi } from "vitest";
import type { LlmClient } from "./client";
import { LlmParseError } from "./client";
import { decideJson, stripFences } from "./decide";
import { EntryDecisionSchema } from "./schema";

function fakeClient(replies: string[]): LlmClient {
  const queue = [...replies];
  return {
    model: "fake",
    complete: vi.fn(async () => ({
      content: queue.shift() ?? "{}",
      model: "fake",
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 3,
    })),
  };
}

const OPTS = {
  system: "sys",
  user: "usr",
  schema: EntryDecisionSchema,
};

describe("stripFences", () => {
  it("removes a ```json fence", () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripFences('{"a":1}')).toBe('{"a":1}');
  });
});

describe("decideJson", () => {
  it("parses a clean JSON reply", async () => {
    const client = fakeClient([
      '{"act":true,"confidence":0.7,"reason":"looks fine","concerns":[]}',
    ]);
    const out = await decideJson(client, OPTS);
    expect(out.value.act).toBe(true);
    expect(out.value.confidence).toBe(0.7);
  });

  it("digs the object out of surrounding prose", async () => {
    const client = fakeClient([
      'Sure — here is my call:\n{"act": false, "confidence": 0.2, "reason": "CPI tomorrow"}\nHope that helps.',
    ]);
    const out = await decideJson(client, OPTS);
    expect(out.value.act).toBe(false);
    expect(out.value.concerns).toEqual([]);
  });

  it("retries once and succeeds on the second reply", async () => {
    const client = fakeClient([
      "no idea, maybe?",
      '{"act":true,"confidence":0.55,"reason":"ok","concerns":["low IV"]}',
    ]);
    const out = await decideJson(client, OPTS);
    expect(out.value.confidence).toBe(0.55);
    expect(client.complete).toHaveBeenCalledTimes(2);
  });

  it("throws LlmParseError when both attempts are unusable", async () => {
    const client = fakeClient(["nope", "still nope"]);
    await expect(decideJson(client, OPTS)).rejects.toBeInstanceOf(LlmParseError);
  });
});
