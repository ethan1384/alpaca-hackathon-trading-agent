import { NextResponse } from "next/server";
import { readRecentDecisionsFromDisk, recentDecisions, serializeForReview } from "@/server/risk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The [O5] decision log. `?limit=1..200` (default 50), `?format=json|review`.
 * Falls back to the JSONL tail when the in-memory ring is cold.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? "50") || 50));
  const format = url.searchParams.get("format") === "review" ? "review" : "json";

  const ring = recentDecisions(limit);
  const records = ring.length > 0 ? ring : await readRecentDecisionsFromDisk(limit);

  if (format === "review") {
    return NextResponse.json({ review: serializeForReview(records) });
  }
  return NextResponse.json({ decisions: records });
}
