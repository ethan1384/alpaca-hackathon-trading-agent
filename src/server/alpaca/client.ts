import "server-only";

import { Alpaca } from "@alpacahq/alpaca-trade-api/rest";
import { getEnv } from "@/config/env";

let cachedRestClient: Alpaca | null = null;

export function getAlpacaRestClient(): Alpaca {
  if (cachedRestClient) {
    return cachedRestClient;
  }

  const env = getEnv();
  cachedRestClient = new Alpaca({
    keyId: env.ALPACA_API_KEY,
    secret: env.ALPACA_API_SECRET,
    paper: env.ALPACA_PAPER,
  });

  return cachedRestClient;
}

let cachedBacktestClient: Alpaca | null = null;

/**
 * Historical market data for the backtests (`getBarsRange`), on its own
 * client so its limiter never queues a live order behind a history download.
 *
 * The SDK rate-limits every client by default with a 200-token bucket that
 * starts full: ~400 requests can go out in the first minute, against Alpaca's
 * 200 per minute — and a multi-year 30-minute history is thousands of pages
 * (~600 bars each). This bucket cannot burst: 3 tokens refilled at 3 per
 * second caps any 60-second window at ~183 requests, every page counted.
 */
export function getBacktestDataClient(): Alpaca {
  if (cachedBacktestClient) {
    return cachedBacktestClient;
  }

  const env = getEnv();
  cachedBacktestClient = new Alpaca({
    keyId: env.ALPACA_API_KEY,
    secret: env.ALPACA_API_SECRET,
    paper: env.ALPACA_PAPER,
    rateLimit: { maxRequests: 3, intervalMs: 1_000, maxConcurrent: 2 },
  });

  return cachedBacktestClient;
}

export function resetAlpacaRestClient(): void {
  cachedRestClient = null;
  cachedBacktestClient = null;
}
