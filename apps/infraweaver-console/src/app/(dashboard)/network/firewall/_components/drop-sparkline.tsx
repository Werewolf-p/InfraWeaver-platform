"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";

interface DropSparklineProps {
  values: number[];
  className?: string;
  /** Stroke + fill hue; defaults to the danger token. */
  color?: string;
}

/**
 * A compact area sparkline of recent drop rate. Self-contained SVG so it stays
 * fully in our control (no chart dep), normalised to its own max so a quiet
 * cluster still reads as a flat calm line rather than noise.
 */
export function DropSparkline({ values, className, color = "var(--az-danger)" }: DropSparklineProps) {
  const gradId = useId();
  const w = 120;
  const h = 32;
  const pts = values.length >= 2 ? values : [...values, ...values, 0].slice(0, 2);
  const max = Math.max(...pts, 0.0001);
  const step = w / (pts.length - 1);
  const coords = pts.map((v, i) => {
    const x = i * step;
    const y = h - (v / max) * (h - 4) - 2;
    return [x, y] as const;
  });
  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;
  const [lastX, lastY] = coords[coords.length - 1];
  const quiet = max <= 0.0001;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className={cn("h-8 w-[120px]", className)}
      preserveAspectRatio="none"
      role="img"
      aria-label="Recent drop rate"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.35} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradId})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {!quiet && (
        <circle cx={lastX} cy={lastY} r={2.6} fill={color}>
          <animate attributeName="r" values="2.6;4.2;2.6" dur="2s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="1;0.5;1" dur="2s" repeatCount="indefinite" />
        </circle>
      )}
    </svg>
  );
}
