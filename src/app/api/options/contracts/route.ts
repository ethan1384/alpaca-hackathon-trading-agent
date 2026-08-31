import { NextResponse } from "next/server";
import type { ZodError } from "zod";
import { OptionChainQuerySchema, OptionContractsQuerySchema } from "@/domain/schemas";
import type { OptionChainResponseBody, OptionExpirationsResponseBody } from "@/domain/sse-events";
import { normalizeSymbol } from "@/domain/types";
import { getOptionChain, listOptionExpirations } from "@/server/alpaca/options";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function badRequest(error: ZodError): NextResponse {
  return NextResponse.json(
    { error: error.issues.map((issue) => issue.message).join(", ") },
    { status: 400 },
  );
}

function upstreamError(error: unknown, fallback: string): NextResponse {
  const message = error instanceof Error ? error.message : fallback;
  return NextResponse.json({ error: message }, { status: 502 });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // No expiration -> list the available expirations for the underlying.
  if (!searchParams.has("expiration")) {
    const parsed = OptionContractsQuerySchema.safeParse({
      underlying: searchParams.get("underlying"),
    });
    if (!parsed.success) {
      return badRequest(parsed.error);
    }
    const underlying = normalizeSymbol(parsed.data.underlying);
    try {
      const expirations = await listOptionExpirations(underlying);
      return NextResponse.json({
        underlying,
        expirations,
      } satisfies OptionExpirationsResponseBody);
    } catch (error) {
      return upstreamError(error, "Failed to load option expirations");
    }
  }

  // With expiration -> the enriched, filterable chain.
  const parsed = OptionChainQuerySchema.safeParse({
    underlying: searchParams.get("underlying"),
    expiration: searchParams.get("expiration"),
    type: searchParams.get("type") ?? undefined,
    strikeGte: searchParams.get("strikeGte") ?? undefined,
    strikeLte: searchParams.get("strikeLte") ?? undefined,
    moneyness: searchParams.get("moneyness") ?? undefined,
  });
  if (!parsed.success) {
    return badRequest(parsed.error);
  }

  const underlying = normalizeSymbol(parsed.data.underlying);
  try {
    const { spot, rows } = await getOptionChain(underlying, {
      expiration: parsed.data.expiration,
      type: parsed.data.type,
      strikeGte: parsed.data.strikeGte,
      strikeLte: parsed.data.strikeLte,
      moneyness: parsed.data.moneyness,
    });
    return NextResponse.json({
      underlying,
      expiration: parsed.data.expiration,
      spot,
      rows,
    } satisfies OptionChainResponseBody);
  } catch (error) {
    return upstreamError(error, "Failed to load option chain");
  }
}
