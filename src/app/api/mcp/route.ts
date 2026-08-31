import { createMcpHandler } from "mcp-handler";
import { getEnv } from "@/config/env";
import { registerTradingTools } from "@/server/mcp/register-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const mcpHandler = createMcpHandler(
  (server) => {
    registerTradingTools(server);
  },
  {
    serverInfo: { name: "alpaca-trading-agent", version: "0.1.0" },
    instructions:
      "Trading + market-data tools for an Alpaca account. Read (get_account, list_positions, list_orders, get_bars, get_option_chain) before writing. Order placement and cancellation act on real Alpaca orders (paper or live per server config).",
  },
);

/** `Authorization: Bearer <MCP_AUTH_TOKEN>` — enforced only when the token is configured. */
function authorized(request: Request): boolean {
  const token = getEnv().MCP_AUTH_TOKEN;
  if (!token) {
    return true;
  }
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${token}`;
}

async function handler(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
    });
  }
  return mcpHandler(request);
}

export { handler as GET, handler as POST, handler as DELETE };
