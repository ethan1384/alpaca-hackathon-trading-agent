import type { UTCTimestamp } from "lightweight-charts";
import type { EquityPoint } from "@/domain/backtest";

/**
 * lightweight-charts needs strictly ascending, unique timestamps. Two points can
 * share a second (two trades closing in the same minute on different
 * underlyings), so collapse those to the later value rather than dropping one.
 */
export function toLineData(
  points: { timestamp: string; value: number }[],
): { time: UTCTimestamp; value: number }[] {
  const byTime = new Map<number, number>();
  for (const point of points) {
    byTime.set(Math.floor(new Date(point.timestamp).getTime() / 1000), point.value);
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time: time as UTCTimestamp, value }));
}

export function equityLine(points: EquityPoint[]): { timestamp: string; value: number }[] {
  return points.map((p) => ({ timestamp: p.timestamp, value: p.equity }));
}

/** Percent below the running peak (≤ 0) at each point. */
export function drawdownLine(points: EquityPoint[]): { timestamp: string; value: number }[] {
  let peak = Number.NEGATIVE_INFINITY;
  return points.map((p) => {
    peak = Math.max(peak, p.equity);
    return { timestamp: p.timestamp, value: peak > 0 ? (p.equity / peak - 1) * 100 : 0 };
  });
}
