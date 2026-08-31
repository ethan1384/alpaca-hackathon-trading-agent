import { afterEach, describe, expect, it, vi } from "vitest";
import { createLlmClient, LlmUnavailableError, stripReasoning } from "./client";

const CFG = { baseUrl: "http://localhost:11434/v1", model: "test-model", timeoutMs: 5_000 };

function mockFetch(impl: typeof fetch) {
  vi.stubGlobal("fetch", impl);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createLlmClient.complete", () => {
  it("posts to /chat/completions and returns content + usage", async () => {
    const seen: { url: string; body: unknown } = { url: "", body: null };
    mockFetch(async (url, init) => {
      seen.url = String(url);
      seen.body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }],
          usage: { prompt_tokens: 12, completion_tokens: 5 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const client = createLlmClient(CFG);
    const result = await client.complete({
      messages: [{ role: "user", content: "hi" }],
      jsonObject: true,
    });

    expect(seen.url).toBe("http://localhost:11434/v1/chat/completions");
    expect((seen.body as { response_format?: unknown }).response_format).toEqual({
      type: "json_object",
    });
    expect(result.content).toBe('{"ok":true}');
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("sends a bearer header only when an api key is set", async () => {
    let auth: string | null = null;
    mockFetch(async (_url, init) => {
      auth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
        status: 200,
      });
    });

    await createLlmClient({ ...CFG, apiKey: "fk-abc" }).complete({
      messages: [{ role: "user", content: "x" }],
    });
    expect(auth).toBe("Bearer fk-abc");
  });

  it("raises LlmUnavailableError on a non-2xx response", async () => {
    mockFetch(
      async () => new Response("upstream is down", { status: 502, statusText: "Bad Gateway" }),
    );
    await expect(
      createLlmClient(CFG).complete({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("raises LlmUnavailableError when fetch throws (connection refused)", async () => {
    mockFetch(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      createLlmClient(CFG).complete({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("raises LlmUnavailableError when the reply has no content", async () => {
    mockFetch(async () => new Response(JSON.stringify({ choices: [{}] }), { status: 200 }));
    await expect(
      createLlmClient(CFG).complete({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("names the token budget when a reasoning model was truncated mid-thought", async () => {
    // Exactly what Ollama returns for qwen3 with a small max_tokens: the whole
    // budget goes to `reasoning`, `content` is empty, finish_reason is "length".
    mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: "", reasoning: "Let me think about SPY..." },
                finish_reason: "length",
              },
            ],
            usage: { completion_tokens: 700 },
          }),
          { status: 200 },
        ),
    );
    await expect(
      createLlmClient(CFG).complete({ messages: [{ role: "user", content: "x" }] }),
    ).rejects.toThrow(/AGENT_LLM_MAX_TOKENS/);
  });

  it("sends the configured token budget and returns out-of-band reasoning", async () => {
    let body: { max_tokens?: number } = {};
    mockFetch(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}', reasoning: "because" } }],
        }),
        { status: 200 },
      );
    });

    const result = await createLlmClient({ ...CFG, maxTokens: 4_096 }).complete({
      messages: [{ role: "user", content: "x" }],
    });
    expect(body.max_tokens).toBe(4_096);
    expect(result.reasoning).toBe("because");
  });

  it("strips inline chain-of-thought, including an unterminated tail", () => {
    expect(stripReasoning('<think>weighing IV</think>{"act":true}')).toBe('{"act":true}');
    expect(stripReasoning('{"act":true}\n<think>still going')).toBe('{"act":true}');
  });
});
