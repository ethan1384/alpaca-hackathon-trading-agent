import { NextResponse } from "next/server";
import { DEFAULT_STREAM_CHANNELS } from "@/config/constants";
import { SubscriptionRequestSchema } from "@/domain/schemas";
import { normalizeSymbol } from "@/domain/types";
import { getMarketHub } from "@/server/hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = SubscriptionRequestSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues.map((i) => i.message).join(", ") },
        { status: 400 },
      );
    }

    const hub = getMarketHub();
    const symbols = parsed.data.symbols.map(normalizeSymbol);

    if (parsed.data.action === "add") {
      await hub.subscribe(symbols);
    } else {
      await hub.unsubscribe(symbols);
    }

    return NextResponse.json({
      ok: true,
      subscribed: hub.getSubscribedSymbols(),
      channels: [...DEFAULT_STREAM_CHANNELS],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Subscription failed";
    const status = message.includes("limit") ? 429 : 400;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
