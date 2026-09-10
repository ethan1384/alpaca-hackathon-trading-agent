import { NextResponse } from "next/server";
import { TriangleBacktestParamsSchema } from "@/domain/backtest-triangle";
import { runTriangleBacktest } from "@/server/backtest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Runs the ascending-triangle breakout backtest (`docs/09-strategie-triangle.md`).
 *
 * Same shape as `/api/backtest`: POST, synchronous, the whole parameter set in
 * the body. Daily bars keep a multi-year, multi-symbol run to a few seconds.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const parsed = TriangleBacktestParamsSchema.safeParse(body);
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
    return NextResponse.json(await runTriangleBacktest(parsed.data));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Backtest failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
