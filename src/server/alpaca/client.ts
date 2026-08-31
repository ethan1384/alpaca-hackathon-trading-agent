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

export function resetAlpacaRestClient(): void {
  cachedRestClient = null;
}
