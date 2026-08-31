import type { Bar } from "@/domain/types";

/**
 * Splice live (always 1-minute) bars onto the tail of a historical series.
 *
 * Live bars at or after the last historical timestamp win: an equal timestamp
 * replaces the trailing historical candle, later ones are appended. Both inputs
 * are expected to be sorted ascending by `timestamp`.
 */
export function mergeTrailingBars(base: Bar[], live: Bar[]): Bar[] {
  if (base.length === 0) {
    return live;
  }
  if (live.length === 0) {
    return base;
  }

  const lastTs = base[base.length - 1].timestamp;
  const tail = live.filter((bar) => bar.timestamp >= lastTs);
  if (tail.length === 0) {
    return base;
  }

  const head = tail[0].timestamp === lastTs ? base.slice(0, -1) : base;
  return [...head, ...tail];
}
