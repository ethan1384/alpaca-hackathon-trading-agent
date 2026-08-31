import { NextResponse } from "next/server";
import { DEFAULT_BUFFER_SIZE, DEFAULT_TIMEFRAME } from "@/config/constants";
import { BarsQuerySchema } from "@/domain/schemas";
import { detectAssetClass, normalizeSymbol } from "@/domain/types";
import { getHistoricalBars } from "@/server/alpaca/rest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const parsed = BarsQuerySchema.safeParse({
    symbol: searchParams.get("symbol"),
    timeframe: searchParams.get("timeframe") ?? undefined,
    limit: searchParams.get("limit") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 },
    );
  }

  const symbol = normalizeSymbol(parsed.data.symbol);
  const timeframe = parsed.data.timeframe ?? DEFAULT_TIMEFRAME;
  const limit = parsed.data.limit ?? DEFAULT_BUFFER_SIZE;

  try {
    const bars = await getHistoricalBars(symbol, timeframe, limit);
    return NextResponse.json({
      symbol,
      timeframe,
      assetClass: detectAssetClass(symbol),
      bars,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch bars";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
