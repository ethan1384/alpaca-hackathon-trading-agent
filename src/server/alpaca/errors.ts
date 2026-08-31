import "server-only";

import { NextResponse } from "next/server";

/**
 * Map an error thrown by the Alpaca SDK (or our own validation) to a JSON
 * response. Alpaca `ApiError` subclasses carry a numeric `status`; anything
 * else is treated as a 502 upstream failure.
 */
export function alpacaErrorResponse(error: unknown, fallback: string): NextResponse {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: unknown }).status)
      : undefined;
  const message = error instanceof Error ? error.message : fallback;

  if (status && status >= 400 && status < 600) {
    return NextResponse.json({ error: message }, { status });
  }
  return NextResponse.json({ error: message }, { status: 502 });
}
