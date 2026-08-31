"use client";

import {
  BaselineSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { EquityPoint } from "@/domain/backtest";

interface EquityCurveProps {
  points: EquityPoint[];
  /** Starting equity — the baseline the curve is coloured against. */
  baseline: number;
  height?: number;
}

const UP = "#10b981";
const DOWN = "#ef4444";

/**
 * The backtest's equity curve, drawn against starting equity so the eye reads
 * "above water / under water" before it reads any number. One point per closed
 * trade — the curve is a ledger, not a time series, so gaps between sessions
 * are expected.
 */
export function EquityCurve({ points, baseline, height = 260 }: EquityCurveProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Baseline"> | null>(null);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const chart = createChart(containerRef.current, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#94a3b8",
      },
      grid: {
        vertLines: { color: "rgba(148, 163, 184, 0.1)" },
        horzLines: { color: "rgba(148, 163, 184, 0.1)" },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: false, secondsVisible: false },
      crosshair: { mode: 0 },
    });

    const series = chart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: baseline },
      topLineColor: UP,
      topFillColor1: "rgba(16, 185, 129, 0.28)",
      topFillColor2: "rgba(16, 185, 129, 0.02)",
      bottomLineColor: DOWN,
      bottomFillColor1: "rgba(239, 68, 68, 0.02)",
      bottomFillColor2: "rgba(239, 68, 68, 0.28)",
      priceFormat: { type: "price", precision: 0, minMove: 1 },
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        chart.applyOptions({ width: entry.contentRect.width });
      }
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [height, baseline]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) {
      return;
    }

    // lightweight-charts needs strictly ascending, unique timestamps. Two trades
    // can close in the same minute on different underlyings, so collapse those
    // to the later equity value rather than dropping a point.
    const byTime = new Map<number, number>();
    for (const point of points) {
      byTime.set(Math.floor(new Date(point.timestamp).getTime() / 1000), point.equity);
    }
    const data = [...byTime.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([time, value]) => ({ time: time as UTCTimestamp, value }));

    series.setData(data);
    chartRef.current?.timeScale().fitContent();
  }, [points]);

  return <div ref={containerRef} className="w-full" />;
}
