import "server-only";

import { RISK } from "@/config/risk";

/**
 * [O4] Reject handling: retry with backoff, alert past N consecutive failures.
 *
 * The distinction that matters is **which** failures deserve a retry. A 429 or a
 * 5xx is the venue being busy — retrying is correct. A 4xx is Alpaca telling us
 * the order is wrong (bad symbol, insufficient buying power, unsupported order
 * type); retrying it just sends the same wrong order again, three times, and
 * buries the real message under a timeout. So only transport-level and
 * rate-limit failures are retried.
 *
 * The consecutive-failure counter is per-operation and deliberately *not* reset
 * by a retry succeeding on attempt 3 — it counts operations that failed
 * outright, which is the signal that something systemic is wrong.
 */

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = Number((error as { status: unknown }).status);
    return Number.isFinite(status) ? status : undefined;
  }
  return undefined;
}

/**
 * Transport failure (no response at all) or a status the venue may recover from.
 *
 * `retryOnNoResponse` exists because "no response" is genuinely ambiguous for a
 * write: the order may have been accepted and only the reply lost. Reads can
 * always retry it; an order submission may only do so when it carries an
 * idempotency key (`clientOrderId`), which turns a double-send into a duplicate
 * rejection instead of a double fill.
 */
export function isRetryable(error: unknown, retryOnNoResponse = true): boolean {
  const status = statusOf(error);
  if (status === undefined) {
    return retryOnNoResponse;
  }
  return RETRYABLE_STATUSES.has(status);
}

const failureCounts = new Map<string, number>();

/** Consecutive outright failures for `operation`. */
export function consecutiveFailures(operation: string): number {
  return failureCounts.get(operation) ?? 0;
}

export function resetFailureCounts(): void {
  failureCounts.clear();
}

export interface RetryOptions {
  /** Label used for the failure counter and log lines. */
  operation: string;
  attempts?: number;
  baseDelayMs?: number;
  /** Injectable for tests — default sleeps. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Whether a failure with no HTTP status may be retried. Leave `true` for
   * reads. Set `false` for a non-idempotent write — see `isRetryable`.
   */
  retryOnNoResponse?: boolean;
  /**
   * Wait before the next attempt, given the failure and the exponential
   * backoff that would otherwise apply. Lets a caller honour a rate-limit
   * window (a 429 is only worth retrying once the window has reset) without
   * a second retry loop. Omit for plain exponential backoff.
   */
  delayMs?: (error: unknown, attempt: number, backoffMs: number) => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying retryable failures with exponential backoff. Rethrows the
 * last error once attempts are exhausted or the error is not retryable — the
 * caller still has to handle failure; this only removes the transient case.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    operation,
    attempts = 3,
    baseDelayMs = RISK.retryBaseDelayMs,
    sleep = defaultSleep,
    retryOnNoResponse = true,
    delayMs,
  } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await fn();
      failureCounts.set(operation, 0);
      return result;
    } catch (error) {
      lastError = error;
      if (!isRetryable(error, retryOnNoResponse) || attempt === attempts) {
        break;
      }
      const backoff = baseDelayMs * 2 ** (attempt - 1);
      const delay = delayMs ? Math.max(0, delayMs(error, attempt, backoff)) : backoff;
      console.warn(
        `[retry] ${operation} attempt ${attempt}/${attempts} failed (${statusOf(error) ?? "no response"}), retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }

  const failures = consecutiveFailures(operation) + 1;
  failureCounts.set(operation, failures);
  if (failures >= RISK.maxConsecutiveRejects) {
    console.error(
      `[retry] ALERT — ${operation} has failed ${failures} times in a row. Something systemic is wrong; stop retrying and look.`,
    );
  }
  throw lastError;
}
