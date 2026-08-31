import { NextResponse } from "next/server";
import { getEnv } from "@/config/env";
import { getMarketClock } from "@/server/alpaca/rest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const env = getEnv();
    const clock = await getMarketClock();

    return NextResponse.json({
      ...clock,
      paper: env.ALPACA_PAPER,
      feed: env.ALPACA_DATA_FEED,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch market clock";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
