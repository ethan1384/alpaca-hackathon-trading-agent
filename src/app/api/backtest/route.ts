import { NextResponse } from "next/server";
import { BacktestParamsSchema } from "@/domain/backtest";
import { runBacktest } from "@/server/backtest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Runs the ORB → 0DTE debit-vertical backtest.
 *
 * POST rather than GET: the parameter set is large, and every friction knob
 * (`frictionPerLeg`, `stopRecoveryPct`, …) belongs in the body where it stays
 * legible. A run over a few weeks of minute bars takes seconds, so this stays
 * synchronous — see `docs/06-options-parameters.md` [R15] for what a backtest
 * is and is not evidence of.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = BacktestParamsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") },
      { status: 400 },
    );
  }

  if (parsed.data.start > parsed.data.end) {
    return NextResponse.json({ error: "start must be on or before end" }, { status: 400 });
  }

  try {
    return NextResponse.json(await runBacktest(parsed.data));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Backtest failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
