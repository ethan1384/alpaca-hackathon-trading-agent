import { beforeEach, describe, expect, it, vi } from "vitest";
import { consecutiveFailures, isRetryable, resetFailureCounts, withRetry } from "./retry";

const noSleep = async () => {};

function httpError(status: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

describe("withRetry [O4]", () => {
  beforeEach(() => {
    resetFailureCounts();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns on the first success without sleeping", async () => {
    const sleep = vi.fn(noSleep);
    await expect(withRetry(async () => "ok", { operation: "t", sleep })).resolves.toBe("ok");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a 429 and succeeds", async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(429))
      .mockResolvedValue("ok");
    await expect(withRetry(fn, { operation: "t", sleep: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 422 — the same wrong order sent three times is still wrong", async () => {
    const fn = vi.fn(async () => {
      throw httpError(422);
    });
    await expect(withRetry(fn, { operation: "t", sleep: noSleep })).rejects.toThrow("HTTP 422");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("retries a transport failure with no status — it never reached the venue", async () => {
    expect(isRetryable(new Error("ECONNRESET"))).toBe(true);
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue("ok");
    await expect(withRetry(fn, { operation: "t", sleep: noSleep })).resolves.toBe("ok");
  });

  it("does not retry a no-response failure when the caller says the write is not idempotent", async () => {
    const fn = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(
      withRetry(fn, { operation: "t", sleep: noSleep, retryOnNoResponse: false }),
    ).rejects.toThrow("ECONNRESET");
    expect(fn).toHaveBeenCalledOnce();
    expect(isRetryable(new Error("ECONNRESET"), false)).toBe(false);
  });

  it("backs off exponentially", async () => {
    const delays: number[] = [];
    const fn = vi.fn(async () => {
      throw httpError(503);
    });
    await expect(
      withRetry(fn, {
        operation: "t",
        attempts: 3,
        baseDelayMs: 100,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    ).rejects.toThrow();
    expect(delays).toEqual([100, 200]);
  });

  it("lets the caller replace the backoff per failure — e.g. wait out a rate-limit window", async () => {
    const delays: number[] = [];
    const seen: [number, number][] = [];
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(httpError(429))
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValue("ok");
    await expect(
      withRetry(fn, {
        operation: "t",
        baseDelayMs: 100,
        sleep: async (ms) => {
          delays.push(ms);
        },
        delayMs: (error, attempt, backoff) => {
          seen.push([attempt, backoff]);
          return (error as { status: number }).status === 429 ? 61_000 : backoff;
        },
      }),
    ).resolves.toBe("ok");
    expect(seen).toEqual([
      [1, 100],
      [2, 200],
    ]);
    expect(delays).toEqual([61_000, 200]);
  });

  it("counts outright failures and alerts past the threshold", async () => {
    const fail = () =>
      withRetry(
        async () => {
          throw httpError(422);
        },
        { operation: "place", sleep: noSleep },
      ).catch(() => {});
    await fail();
    await fail();
    expect(consecutiveFailures("place")).toBe(2);
    await fail();
    expect(consecutiveFailures("place")).toBe(3);
    expect(console.error).toHaveBeenCalled();
  });

  it("resets the counter on a success", async () => {
    await withRetry(
      async () => {
        throw httpError(422);
      },
      { operation: "place", sleep: noSleep },
    ).catch(() => {});
    await withRetry(async () => "ok", { operation: "place", sleep: noSleep });
    expect(consecutiveFailures("place")).toBe(0);
  });
});
