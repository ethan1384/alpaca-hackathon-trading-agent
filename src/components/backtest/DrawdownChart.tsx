"use client";

import {
  BaselineSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  LineSeries,
  LineStyle,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import { drawdownLine, toLineData } from "@/components/backtest/chart-data";
import type { EquityPoint } from "@/domain/backtest";

interface DrawdownChartProps {
  points: EquityPoint[];
  /** Comparison curve, drawn dashed — same one the equity chart shows. */
  benchmark?: EquityPoint[];
  height?: number;
}

const percent = { type: "custom" as const, formatter: (v: number) => `${v.toFixed(1)}%` };

/**
 * Underwater chart: how far below its running high the book sat, session by
 * session. The equity curve shows where it ended; this shows what it cost to
 * sit through.
 */
export function DrawdownChart({ points, benchmark, height = 150 }: DrawdownChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Baseline"> | null>(null);
  const benchmarkRef = useRef<ISeriesApi<"Line"> | null>(null);

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

    const benchmarkSeries = chart.addSeries(LineSeries, {
      color: "#94a3b8",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      priceFormat: percent,
    });

    const series = chart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: 0 },
      topLineColor: "rgba(0, 0, 0, 0)",
      topFillColor1: "rgba(0, 0, 0, 0)",
      topFillColor2: "rgba(0, 0, 0, 0)",
      bottomLineColor: "#ef4444",
      bottomFillColor1: "rgba(239, 68, 68, 0.05)",
      bottomFillColor2: "rgba(239, 68, 68, 0.35)",
      priceFormat: percent,
    });

    chartRef.current = chart;
    seriesRef.current = series;
    benchmarkRef.current = benchmarkSeries;

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
      benchmarkRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) {
      return;
    }
    series.setData(toLineData(drawdownLine(points)));
    benchmarkRef.current?.setData(toLineData(drawdownLine(benchmark ?? [])));
    chartRef.current?.timeScale().fitContent();
  }, [points, benchmark]);

  return <div ref={containerRef} className="w-full" />;
}
