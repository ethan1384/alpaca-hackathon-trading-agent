import { NextResponse } from "next/server";
import { ClosePositionSchema } from "@/domain/trading";
import { normalizeSymbol } from "@/domain/types";
import { alpacaErrorResponse } from "@/server/alpaca/errors";
import { closePosition, getPosition } from "@/server/alpaca/trading";
import { recordManualAction } from "@/server/risk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await ctx.params;
  try {
    return NextResponse.json(await getPosition(normalizeSymbol(symbol)));
  } catch (error) {
    return alpacaErrorResponse(error, "Failed to load position");
  }
}

/** Close (liquidate) a single position. Body: `{ qty? }` or `{ percentage? }`. */
export async function DELETE(request: Request, ctx: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await ctx.params;
  const raw = await request.json().catch(() => ({}));
  const parsed = ClosePositionSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 },
    );
  }
  const sym = normalizeSymbol(symbol);
  try {
    const order = await closePosition(sym, parsed.data);
    await recordManualAction({
      action: "close_position",
      underlying: sym,
      legs: [sym],
      reason: "manual close via REST /api/positions/:symbol",
      outcome: { status: "submitted", orderId: order.id },
      source: "rest",
    });
    return NextResponse.json(order);
  } catch (error) {
    await recordManualAction({
      action: "close_position",
      underlying: sym,
      legs: [sym],
      reason: "manual close via REST /api/positions/:symbol",
      outcome: { status: "error", error: error instanceof Error ? error.message : String(error) },
      source: "rest",
    });
    return alpacaErrorResponse(error, "Failed to close position");
  }
}
