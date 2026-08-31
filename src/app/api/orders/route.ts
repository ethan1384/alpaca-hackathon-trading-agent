import { NextResponse } from "next/server";
import { ListOrdersQuerySchema, PlaceOrderSchema } from "@/domain/trading";
import { alpacaErrorResponse } from "@/server/alpaca/errors";
import { cancelAllOrders, listOrders, placeOrder } from "@/server/alpaca/trading";
import { describeOrder, recordManualAction } from "@/server/risk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const parsed = ListOrdersQuerySchema.safeParse({
    status: searchParams.get("status") ?? undefined,
    limit: searchParams.get("limit") ?? undefined,
    direction: searchParams.get("direction") ?? undefined,
    nested: searchParams.get("nested") ?? undefined,
    symbols: searchParams.get("symbols") ?? undefined,
    side: searchParams.get("side") ?? undefined,
    after: searchParams.get("after") ?? undefined,
    until: searchParams.get("until") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json({ orders: await listOrders(parsed.data) });
  } catch (error) {
    return alpacaErrorResponse(error, "Failed to load orders");
  }
}

/** Place an order. See `PlaceOrderSchema` for the accepted shapes (market / limit / stop / bracket / …). */
export async function POST(request: Request) {
  const raw = await request.json().catch(() => null);
  const parsed = PlaceOrderSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") },
      { status: 400 },
    );
  }
  const described = describeOrder(parsed.data);
  try {
    const order = await placeOrder(parsed.data);
    await recordManualAction({
      action: "place_order",
      ...described,
      reason: "raw order via REST /api/orders",
      outcome: { status: "submitted", orderId: order.id },
      source: "rest",
    });
    return NextResponse.json(order, { status: 201 });
  } catch (error) {
    await recordManualAction({
      action: "place_order",
      ...described,
      reason: "raw order via REST /api/orders",
      outcome: { status: "error", error: error instanceof Error ? error.message : String(error) },
      source: "rest",
    });
    return alpacaErrorResponse(error, "Failed to place order");
  }
}

/** Cancel every open order. */
export async function DELETE() {
  try {
    const canceled = await cancelAllOrders();
    await recordManualAction({
      action: "cancel_all_orders",
      reason: "cancel every open order via REST /api/orders",
      outcome: { status: "submitted" },
      source: "rest",
    });
    return NextResponse.json({ canceled });
  } catch (error) {
    await recordManualAction({
      action: "cancel_all_orders",
      reason: "cancel every open order via REST /api/orders",
      outcome: { status: "error", error: error instanceof Error ? error.message : String(error) },
      source: "rest",
    });
    return alpacaErrorResponse(error, "Failed to cancel orders");
  }
}
