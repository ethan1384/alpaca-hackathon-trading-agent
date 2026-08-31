import { afterEach, describe, expect, it } from "vitest";
import { getEnv, resetEnvCache } from "./env";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetEnvCache();
});

describe("getEnv", () => {
  it("throws when required keys are missing", () => {
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_API_SECRET;

    expect(() => getEnv()).toThrow(/ALPACA_API_KEY/);
  });

  it("parses defaults and symbol list", () => {
    process.env.ALPACA_API_KEY = "key";
    process.env.ALPACA_API_SECRET = "secret";
    process.env.NEXT_PUBLIC_DEFAULT_SYMBOLS = "AAPL,TSLA";

    const env = getEnv();

    expect(env.ALPACA_PAPER).toBe(true);
    expect(env.defaultSymbols).toEqual(["AAPL", "TSLA"]);
  });

  it("defaults the agent LLM settings to a local Ollama", () => {
    process.env.ALPACA_API_KEY = "key";
    process.env.ALPACA_API_SECRET = "secret";
    delete process.env.AGENT_LLM_BASE_URL;
    delete process.env.AGENT_LLM_MODEL;
    delete process.env.AGENT_LLM_API_KEY;
    delete process.env.AGENT_ENABLED;

    const env = getEnv();

    expect(env.AGENT_LLM_BASE_URL).toBe("http://localhost:11434/v1");
    expect(env.AGENT_LLM_MODEL).toMatch(/qwen/);
    expect(env.AGENT_LLM_API_KEY).toBeUndefined();
    expect(env.AGENT_LLM_TIMEOUT_MS).toBe(120_000);
    expect(env.AGENT_LLM_MAX_TOKENS).toBe(4_096);
    expect(env.AGENT_ENABLED).toBe(true);
  });

  it("reads an override endpoint (e.g. Featherless) and disables flag", () => {
    process.env.ALPACA_API_KEY = "key";
    process.env.ALPACA_API_SECRET = "secret";
    process.env.AGENT_LLM_BASE_URL = "https://api.featherless.ai/v1";
    process.env.AGENT_LLM_API_KEY = "fk-123";
    process.env.AGENT_LLM_MODEL = "Qwen/Qwen2.5-14B-Instruct";
    process.env.AGENT_ENABLED = "false";

    const env = getEnv();

    expect(env.AGENT_LLM_BASE_URL).toBe("https://api.featherless.ai/v1");
    expect(env.AGENT_LLM_API_KEY).toBe("fk-123");
    expect(env.AGENT_LLM_MODEL).toBe("Qwen/Qwen2.5-14B-Instruct");
    expect(env.AGENT_ENABLED).toBe(false);
  });

  it("defaults agent storage to filesystem", () => {
    process.env.ALPACA_API_KEY = "key";
    process.env.ALPACA_API_SECRET = "secret";
    delete process.env.AGENT_STORAGE;

    expect(getEnv().AGENT_STORAGE).toBe("filesystem");
  });
});
