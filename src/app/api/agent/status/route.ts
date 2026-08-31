import { NextResponse } from "next/server";
import { buildAgentStatus } from "@/server/agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only agent state for the dashboard: config, competition phase, account
 * check, working-memory dump, open spreads. `?withMarks=true` also prices each
 * open spread (one snapshot call per spread).
 */
export async function GET(request: Request) {
  const withMarks = new URL(request.url).searchParams.get("withMarks") === "true";
  try {
    return NextResponse.json(await buildAgentStatus({ withMarks }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to load agent status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
