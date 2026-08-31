import { NextResponse } from "next/server";
import { ReplaceOrderSchema } from "@/domain/trading";
import { alpacaErrorResponse } from "@/server/alpaca/errors";
import { cancelOrder, getOrder, replaceOrder } from "@/server/alpaca/trading";
import { recordManualAction } from "@/server/risk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    return NextResponse.json(await getOrder(id));
  } catch (error) {
    return alpacaErrorResponse(error, "Failed to load order");
  }
}

/** Replace (modify) an open order. Body: `{ qty?, limitPrice?, stopPrice?, trail?, timeInForce? }`. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const raw = await request.json().catch(() => null);
  const parsed = ReplaceOrderSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 },
    );
  }
  try {
    const order = await replaceOrder(id, parsed.data);
    await recordManualAction({
      action: "replace_order",
      reason: `replace ${id} via REST: ${JSON.stringify(parsed.data)}`,
      outcome: { status: "submitted", orderId: order.id },
      source: "rest",
    });
    return NextResponse.json(order);
  } catch (error) {
    await recordManualAction({
      action: "replace_order",
      reason: `replace ${id} via REST`,
      outcome: { status: "error", error: error instanceof Error ? error.message : String(error) },
      source: "rest",
    });
    return alpacaErrorResponse(error, "Failed to replace order");
  }
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    await cancelOrder(id);
    await recordManualAction({
      action: "cancel_order",
      reason: `cancel ${id} via REST`,
      outcome: { status: "submitted", orderId: id },
      source: "rest",
    });
    return NextResponse.json({ ok: true, id });
  } catch (error) {
    await recordManualAction({
      action: "cancel_order",
      reason: `cancel ${id} via REST`,
      outcome: { status: "error", error: error instanceof Error ? error.message : String(error) },
      source: "rest",
    });
    return alpacaErrorResponse(error, "Failed to cancel order");
  }
}
