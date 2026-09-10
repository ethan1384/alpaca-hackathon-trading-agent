"use client";

import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  LineSeries,
  LineStyle,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import type { Bar } from "@/domain/types";

/**
 * An annotation pinned to a bar — the agent's decisions plotted on the tape.
 * `time` must be an ISO timestamp aligned to an existing bar (floor it to the
 * candle's period first), otherwise the marker has no anchor to draw against.
 */
export interface ChartMarker {
  time: string;
  position: "aboveBar" | "belowBar" | "inBar";
  shape: "circle" | "square" | "arrowUp" | "arrowDown";
  color: string;
  text?: string;
  size?: number;
}

/** A horizontal reference level — e.g. the short/long strikes of an open spread. */
export interface ChartPriceLine {
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
}

/**
 * A free-form polyline over the candles — e.g. a sloped trendline. Unlike a
 * `ChartPriceLine` it spans only its own points. Times follow the same rule as
 * markers: align them to existing bars.
 */
export interface ChartLine {
  points: { time: string; value: number }[];
  color: string;
  dashed?: boolean;
  width?: 1 | 2 | 3 | 4;
}

interface PriceChartProps {
  bars: Bar[];
  height?: number;
  /** Render a volume histogram pinned to the bottom of the chart. */
  showVolume?: boolean;
  /** Render a TradingView-style O/H/L/C legend that follows the crosshair. */
  showLegend?: boolean;
  /** Show intraday time (HH:MM) on the time axis and crosshair. */
  intraday?: boolean;
  /** Bar-anchored annotations. Memoize: a new array identity redraws them all. */
  markers?: ChartMarker[];
  /** Horizontal levels drawn across the pane and labelled on the price scale. */
  priceLines?: ChartPriceLine[];
  /** Polylines drawn over the candles. Memoize, like `markers`. */
  lines?: ChartLine[];
}

const UP = "#10b981";
const DOWN = "#ef4444";

function toChartTime(timestamp: string): UTCTimestamp {
  return Math.floor(new Date(timestamp).getTime() / 1000) as UTCTimestamp;
}

function fmt(value: number | undefined): string {
  return value == null ? "—" : value.toFixed(2);
}

export function PriceChart({
  bars,
  height = 220,
  showVolume = false,
  showLegend = false,
  intraday = false,
  markers,
  priceLines,
  lines,
}: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lastBarRef = useRef<Bar | null>(null);
  const firstTimeRef = useRef<string | null>(null);
  const lengthRef = useRef(0);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [legend, setLegend] = useState<Bar | null>(null);
  // The series kept in state, not just a ref: the overlay effects below must
  // re-run when the chart is torn down and rebuilt, or they would write markers
  // and price lines into a disposed series.
  const [chartSeries, setChartSeries] = useState<ISeriesApi<"Candlestick"> | null>(null);

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
      timeScale: { borderVisible: false, timeVisible: intraday, secondsVisible: false },
      crosshair: { mode: 0 },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });

    chartRef.current = chart;
    seriesRef.current = series;
    markersRef.current = createSeriesMarkers(series, []);
    setChartSeries(series);
    lastBarRef.current = null;
    firstTimeRef.current = null;
    lengthRef.current = 0;

    if (showVolume) {
      const volume = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
      });
      chart.priceScale("volume").applyOptions({
        scaleMargins: { top: 0.82, bottom: 0 },
      });
      volumeRef.current = volume;
    }

    if (showLegend) {
      chart.subscribeCrosshairMove((param) => {
        const value = param.seriesData.get(series) as
          | { open: number; high: number; low: number; close: number }
          | undefined;
        if (!value) {
          setLegend(lastBarRef.current);
          return;
        }
        setLegend({
          symbol: "",
          assetClass: "stock",
          open: value.open,
          high: value.high,
          low: value.low,
          close: value.close,
          volume: 0,
          timestamp: "",
        });
      });
    }

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
      markersRef.current = null;
      volumeRef.current = null;
      lastBarRef.current = null;
      setChartSeries(null);
    };
  }, [height, showVolume, showLegend, intraday]);

  useEffect(() => {
    const plugin = markersRef.current;
    if (!chartSeries || !plugin) {
      return;
    }
    // lightweight-charts requires markers sorted ascending by time.
    const sorted = [...(markers ?? [])].sort(
      (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime(),
    );
    plugin.setMarkers(
      sorted.map(
        (marker): SeriesMarker<Time> => ({
          time: toChartTime(marker.time),
          position: marker.position,
          shape: marker.shape,
          color: marker.color,
          text: marker.text,
          size: marker.size,
        }),
      ),
    );
  }, [chartSeries, markers]);

  useEffect(() => {
    if (!chartSeries || !priceLines?.length) {
      return;
    }
    const created: IPriceLine[] = priceLines.map((line) =>
      chartSeries.createPriceLine({
        price: line.price,
        color: line.color,
        lineWidth: 1,
        lineStyle: line.dashed ? LineStyle.Dashed : LineStyle.Solid,
        lineVisible: true,
        axisLabelVisible: true,
        title: line.title,
        axisLabelColor: line.color,
        axisLabelTextColor: "#0f172a",
      }),
    );
    return () => {
      for (const line of created) {
        try {
          chartSeries.removePriceLine(line);
        } catch {
          // The chart was disposed first — its own teardown already dropped these.
        }
      }
    };
  }, [chartSeries, priceLines]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !chartSeries || !lines?.length) {
      return;
    }
    const created = lines.map((line) => {
      const series = chart.addSeries(LineSeries, {
        color: line.color,
        lineWidth: line.width ?? 2,
        lineStyle: line.dashed ? LineStyle.Dashed : LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      // Strictly ascending, unique times — the library throws otherwise.
      const byTime = new Map<number, number>();
      for (const point of line.points) {
        byTime.set(toChartTime(point.time), point.value);
      }
      series.setData(
        [...byTime.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([time, value]) => ({ time: time as UTCTimestamp, value })),
      );
      return series;
    });
    return () => {
      for (const series of created) {
        try {
          chart.removeSeries(series);
        } catch {
          // Chart already disposed — its teardown dropped these.
        }
      }
    };
  }, [chartSeries, lines]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series || bars.length === 0) {
      return;
    }

    const latest = bars.at(-1);
    if (!latest) {
      return;
    }

    const volume = volumeRef.current;
    const previous = lastBarRef.current;

    // Treat the update as an incremental tick/append only when the series head is
    // unchanged and nothing was dropped; otherwise reload the whole dataset (first
    // paint, timeframe switch, symbol change).
    const isIncremental =
      previous != null &&
      bars.length > 1 &&
      bars[0].timestamp === firstTimeRef.current &&
      bars.length >= lengthRef.current;

    if (!isIncremental) {
      series.setData(
        bars.map((bar) => ({
          time: toChartTime(bar.timestamp),
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        })),
      );
      volume?.setData(
        bars.map((bar) => ({
          time: toChartTime(bar.timestamp),
          value: bar.volume,
          color: bar.close >= bar.open ? "rgba(16,185,129,0.4)" : "rgba(239,68,68,0.4)",
        })),
      );
      chartRef.current?.timeScale().fitContent();
    } else {
      series.update({
        time: toChartTime(latest.timestamp),
        open: latest.open,
        high: latest.high,
        low: latest.low,
        close: latest.close,
      });
      volume?.update({
        time: toChartTime(latest.timestamp),
        value: latest.volume,
        color: latest.close >= latest.open ? "rgba(16,185,129,0.4)" : "rgba(239,68,68,0.4)",
      });
    }

    lastBarRef.current = latest;
    firstTimeRef.current = bars[0].timestamp;
    lengthRef.current = bars.length;
    setLegend(latest);
  }, [bars]);

  return (
    <div className="relative w-full">
      {showLegend && legend && (
        <div className="pointer-events-none absolute left-2 top-2 z-10 flex gap-3 rounded-md bg-background/70 px-2 py-1 text-xs tabular-nums backdrop-blur-sm">
          <span>
            O <span className="text-foreground">{fmt(legend.open)}</span>
          </span>
          <span>
            H <span className="text-foreground">{fmt(legend.high)}</span>
          </span>
          <span>
            L <span className="text-foreground">{fmt(legend.low)}</span>
          </span>
          <span>
            C <span className="text-foreground">{fmt(legend.close)}</span>
          </span>
        </div>
      )}
      <div ref={containerRef} className="w-full" />
    </div>
  );
}
