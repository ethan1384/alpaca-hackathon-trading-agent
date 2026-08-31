import { NextResponse } from "next/server";
import { alpacaErrorResponse } from "@/server/alpaca/errors";
import { closeAllPositions, listPositions } from "@/server/alpaca/trading";
import { recordManualAction } from "@/server/risk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ positions: await listPositions() });
  } catch (error) {
    return alpacaErrorResponse(error, "Failed to load positions");
  }
}

/** Liquidate every open position. `?cancelOrders=true` also cancels open orders first. */
export async function DELETE(request: Request) {
  const cancelOrders = new URL(request.url).searchParams.get("cancelOrders") === "true";
  try {
    const closed = await closeAllPositions(cancelOrders);
    await recordManualAction({
      action: "close_all_positions",
      reason: `liquidate every open position via REST (cancelOrders=${cancelOrders})`,
      outcome: { status: "submitted" },
      source: "rest",
    });
    return NextResponse.json({ closed });
  } catch (error) {
    await recordManualAction({
      action: "close_all_positions",
      reason: `liquidate every open position via REST (cancelOrders=${cancelOrders})`,
      outcome: { status: "error", error: error instanceof Error ? error.message : String(error) },
      source: "rest",
    });
    return alpacaErrorResponse(error, "Failed to close positions");
  }
}
