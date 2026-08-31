import type { StreamEvent } from "@/domain/sse-events";

type FlushHandler = (events: StreamEvent[]) => void;

export class EventCoalescer {
  private pending = new Map<string, StreamEvent>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly flushMs: number,
    private readonly onFlush: FlushHandler,
  ) {}

  push(event: StreamEvent): void {
    const key = `${event.type}:${"symbol" in event.data ? (event.data as { symbol?: string }).symbol : "global"}`;
    this.pending.set(key, event);

    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushMs);
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.pending.size === 0) {
      return;
    }

    const events = [...this.pending.values()];
    this.pending.clear();
    this.onFlush(events);
  }

  dispose(): void {
    this.flush();
  }
}
