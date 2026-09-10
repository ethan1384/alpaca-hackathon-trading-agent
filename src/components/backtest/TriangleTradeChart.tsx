"use client";

import { useMemo } from "react";
import {
  type ChartLine,
  type ChartMarker,
  type ChartPriceLine,
  PriceChart,
} from "@/components/dashboard/PriceChart";
import type { CompactBar, TriangleExitReason, TriangleTrade } from "@/domain/backtest-triangle";
import type { Bar } from "@/domain/types";

export const EXIT_COLORS: Record<TriangleExitReason, string> = {
  stop: "#ef4444",
  target: "#10b981",
  take_profit: "#22c55e",
  time_stop: "#f59e0b",
  dte_floor: "#a855f7",
  end_of_data: "#94a3b8",
};

const RESISTANCE = "#f59e0b";
const SUPPORT = "#3b82f6";
/** Context drawn around the pattern, in bars. */
const BARS_BEFORE = 25;
const BARS_AFTER = 15;

const toSeconds = (timestamp: string) => Math.floor(Date.parse(timestamp) / 1000);

function fromCompact(underlying: string, [time, open, high, low, close, volume]: CompactBar): Bar {
  return {
    symbol: underlying,
    assetClass: "stock",
    open,
    high,
    low,
    close,
    volume,
    timestamp: new Date(time * 1000).toISOString(),
  };
}

/**
 * One trade, drawn the way the detector saw it: the lid and its touches, the
 * rising floor through its swing lows, the breakout, then entry and exit with
 * the target, stop and strikes as levels.
 */
export function TriangleTradeChart({ trade, bars }: { trade: TriangleTrade; bars: CompactBar[] }) {
  const { window, markers, lines, priceLines } = useMemo(() => {
    const { triangle } = trade;
    const start = toSeconds(triangle.startTimestamp);
    const exit = toSeconds(trade.exitTimestamp);
    const startIndex = Math.max(
      0,
      bars.findIndex((b) => b[0] >= start),
    );
    const exitIndex = bars.findIndex((b) => b[0] >= exit);
    const from = Math.max(0, startIndex - BARS_BEFORE);
    const to = exitIndex === -1 ? bars.length : Math.min(bars.length, exitIndex + BARS_AFTER + 1);

    const markers: ChartMarker[] = [
      ...triangle.touches.map(
        (t): ChartMarker => ({
          time: t.timestamp,
          position: "aboveBar",
          shape: "circle",
          color: RESISTANCE,
          size: 1,
        }),
      ),
      ...triangle.lows.map(
        (l): ChartMarker => ({
          time: l.timestamp,
          position: "belowBar",
          shape: "circle",
          color: SUPPORT,
          size: 1,
        }),
      ),
      {
        time: triangle.breakoutTimestamp,
        position: "aboveBar",
        shape: "square",
        color: RESISTANCE,
        text: `breakout ×${triangle.volumeRatio.toFixed(1)} vol`,
      },
      {
        time: trade.entryTimestamp,
        position: "belowBar",
        shape: "arrowUp",
        color: "#10b981",
        text: `entry ${trade.entrySpot.toFixed(2)}`,
      },
      {
        time: trade.exitTimestamp,
        position: "aboveBar",
        shape: "arrowDown",
        color: EXIT_COLORS[trade.exitReason],
        text: trade.exitReason,
      },
    ];

    const lines: ChartLine[] = [
      {
        points: [
          { time: triangle.startTimestamp, value: triangle.resistance },
          { time: triangle.breakoutTimestamp, value: triangle.resistance },
        ],
        color: RESISTANCE,
      },
      {
        points: [
          { time: triangle.support.from.timestamp, value: triangle.support.from.price },
          { time: triangle.support.to.timestamp, value: triangle.support.to.price },
        ],
        color: SUPPORT,
      },
    ];

    const priceLines: ChartPriceLine[] = [
      { price: triangle.target, color: "#10b981", title: "target", dashed: true },
      { price: trade.stopLevel, color: "#ef4444", title: "stop", dashed: true },
      { price: trade.longStrike, color: "#64748b", title: "long K" },
      ...(trade.shortStrike != null
        ? [{ price: trade.shortStrike, color: "#64748b", title: "short K" }]
        : []),
    ];

    return {
      window: bars.slice(from, to).map((b) => fromCompact(trade.underlying, b)),
      markers,
      lines,
      priceLines,
    };
  }, [trade, bars]);

  return (
    <PriceChart
      bars={window}
      height={380}
      showVolume
      showLegend
      markers={markers}
      lines={lines}
      priceLines={priceLines}
    />
  );
}
