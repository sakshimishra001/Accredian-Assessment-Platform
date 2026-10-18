"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatDate, formatShortDate } from "@/prototype/lib/format";

interface Point {
  date: string;
  value: number;
}

/**
 * Single-series column chart (one brand hue, no legend — the panel title names the series).
 * Thin bars (≤ 24px) with a 4px rounded top anchored at a single baseline, hairline gridlines,
 * a per-bar hover tooltip and an accessible table view.
 */
export function ActivityChart({ data, label }: { data: Point[]; label: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const height = 220;
  const pad = { top: 12, right: 8, bottom: 26, left: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const { ticks, max } = useMemo(() => {
    const peak = Math.max(1, ...data.map((d) => d.value));
    const step = peak > 400 ? 100 : peak > 200 ? 50 : peak > 100 ? 25 : peak > 40 ? 10 : peak > 10 ? 5 : 2;
    const top = Math.ceil(peak / step) * step;
    return { max: top, ticks: Array.from({ length: top / step + 1 }, (_, i) => i * step) };
  }, [data]);

  const band = plotW / Math.max(1, data.length);
  const gap = 2; // surface gap between adjacent bars
  const barW = Math.max(1, Math.min(24, band - gap));
  const labelEvery = Math.ceil(data.length / 7);
  const total = data.reduce((s, d) => s + d.value, 0);

  if (showTable) {
    return (
      <div>
        <div className="mb-2 flex justify-end">
          <button type="button" className="text-xs text-primary hover:underline" onClick={() => setShowTable(false)}>
            View as chart
          </button>
        </div>
        <div className="max-h-[220px] overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <caption className="sr-only">{label}</caption>
            <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">Date</th>
                <th className="px-3 py-1.5 text-right font-medium">{label}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.date} className="border-t">
                  <td className="px-3 py-1">{formatDate(d.date)}</td>
                  <td className="px-3 py-1 text-right tabular-nums">{d.value.toLocaleString("en-IN")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  const h = hover !== null ? data[hover] : null;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          <span className="font-medium text-foreground tabular-nums">{total.toLocaleString("en-IN")}</span> total in period
        </span>
        <button type="button" className="text-primary hover:underline" onClick={() => setShowTable(true)}>
          View as table
        </button>
      </div>
      <div ref={wrap} className="relative w-full" onMouseLeave={() => setHover(null)}>
        <svg width={width} height={height} role="img" aria-label={`${label}: ${total} over ${data.length} days`} className="block">
          {ticks.map((t) => {
            const y = pad.top + plotH - (t / max) * plotH;
            return (
              <g key={t}>
                <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} className="stroke-border" strokeWidth={1} />
                <text x={pad.left - 8} y={y + 4} textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
                  {t.toLocaleString("en-IN")}
                </text>
              </g>
            );
          })}
          {data.map((d, i) => {
            const bh = (d.value / max) * plotH;
            const x = pad.left + i * band + (band - barW) / 2;
            const y = pad.top + plotH - bh;
            const r = Math.min(4, barW / 2, bh);
            // Rounded data-end (top), square at the baseline.
            const path = `M${x},${y + bh} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${y + bh} Z`;
            return (
              <g key={d.date}>
                <path d={path} fill="var(--chart-1)" opacity={hover === null || hover === i ? 1 : 0.45} />
                {/* Hit target: the full band, taller than the mark. */}
                <rect
                  x={pad.left + i * band}
                  y={pad.top}
                  width={band}
                  height={plotH}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  tabIndex={-1}
                />
                {i % labelEvery === 0 ? (
                  <text x={x + barW / 2} y={height - 8} textAnchor="middle" className="fill-muted-foreground text-[11px]">
                    {formatShortDate(d.date)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        {h && hover !== null ? (
          <div
            className="pointer-events-none absolute z-10 rounded-md border bg-popover px-2.5 py-1.5 text-xs shadow-md"
            style={{
              left: Math.min(width - 150, Math.max(0, pad.left + hover * band + band / 2 - 70)),
              top: 0,
            }}
          >
            <div className="text-muted-foreground">{formatDate(h.date)}</div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className="size-2 rounded-sm bg-[var(--chart-1)]" aria-hidden />
              <span className="font-medium tabular-nums">{h.value.toLocaleString("en-IN")}</span>
              <span className="text-muted-foreground">{label.toLowerCase()}</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
