import { HEARTBEAT_INTERVAL_MS } from "@/config/constants";
import type { StreamEvent } from "@/domain/sse-events";
import { getMarketHub } from "@/server/hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function encodeSse(event: StreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export async function GET() {
  const hub = getMarketHub();
  await hub.ensureStarted();

  let removeClient: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();

      const push = (event: StreamEvent) => {
        if (closed) {
          return;
        }
        controller.enqueue(encoder.encode(encodeSse(event)));
      };

      removeClient = hub.addClient(push);

      heartbeat = setInterval(() => {
        push({ type: "heartbeat", data: { ts: Date.now() } });
      }, HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      closed = true;
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      removeClient?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
