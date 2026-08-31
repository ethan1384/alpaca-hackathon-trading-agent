import { NextResponse } from "next/server";
import { alpacaErrorResponse } from "@/server/alpaca/errors";
import { getTradingAccount } from "@/server/alpaca/trading";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getTradingAccount());
  } catch (error) {
    return alpacaErrorResponse(error, "Failed to load account");
  }
}
