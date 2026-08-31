import { NextResponse } from "next/server";
import { CreditBacktestParamsSchema } from "@/domain/backtest-credit";
import { runCreditBacktest } from "@/server/backtest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Runs the short-credit-spread backtest (`docs/strategie-credit-spreads-spy.md`).
 *
 * Same shape as `/api/backtest`: POST, synchronous, the whole parameter set in
 * the body. Evidence of guardrails under [R15], never the official P&L.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = CreditBacktestParamsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") },
      { status: 400 },
    );
  }

  if (parsed.data.start > parsed.data.end) {
    return NextResponse.json({ error: "start must be on or before end" }, { status: 400 });
  }
  if (parsed.data.minDte > parsed.data.maxDte) {
    return NextResponse.json({ error: "minDte must be ≤ maxDte" }, { status: 400 });
  }

  try {
    return NextResponse.json(await runCreditBacktest(parsed.data));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Backtest failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
