"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { animate, motion, useInView, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";
import { EASE_OUT } from "./motion";
import type { DayStatus, HealthStatus, Severity } from "./dummy-data";

// ── Number formatting (locale-free → deterministic, no hydration drift) ───────
function formatNumber(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals);
  const [int, frac] = fixed.split(".");
  const withCommas = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${withCommas}.${frac}` : withCommas;
}

/** Counts up from 0 to `value` on mount. SSR renders 0 on both sides (no mismatch). */
export function AnimatedNumber({
  value,
  decimals = 0,
  prefix = "",
  suffix = "",
  className,
}: {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    // Reduced motion → duration 0 snaps straight to the final value. The count-up
    // runs entirely through animate()'s onUpdate callback, never a synchronous
    // setState in the effect body.
    const controls = animate(0, value, {
      duration: reduced ? 0 : 1.1,
      ease: EASE_OUT,
      onUpdate: (v) => setDisplay(v),
    });
    return () => controls.stop();
  }, [value, reduced]);

  return (
    <span className={className}>
      {prefix}
      {formatNumber(display, decimals)}
      {suffix}
    </span>
  );
}

// ── Health tone bands ─────────────────────────────────────────────────────────
export interface Tone {
  readonly stroke: string;
  readonly text: string;
  readonly soft: string;
  readonly ring: string;
}

const TONE_EMERALD: Tone = { stroke: "#10b981", text: "text-emerald-600 dark:text-emerald-400", soft: "bg-emerald-500/10", ring: "border-emerald-500/30" };
const TONE_SKY: Tone = { stroke: "#0ea5e9", text: "text-sky-600 dark:text-sky-400", soft: "bg-sky-500/10", ring: "border-sky-500/30" };
const TONE_AMBER: Tone = { stroke: "#f59e0b", text: "text-amber-600 dark:text-amber-400", soft: "bg-amber-500/10", ring: "border-amber-500/30" };
const TONE_RED: Tone = { stroke: "#ef4444", text: "text-red-600 dark:text-red-400", soft: "bg-red-500/10", ring: "border-red-500/30" };
const TONE_ZINC: Tone = { stroke: "#a1a1aa", text: "text-zinc-500 dark:text-zinc-400", soft: "bg-zinc-500/10", ring: "border-zinc-500/30" };

export function healthTone(score: number): Tone {
  if (score <= 0) return TONE_ZINC;
  if (score >= 90) return TONE_EMERALD;
  if (score >= 75) return TONE_SKY;
  if (score >= 50) return TONE_AMBER;
  return TONE_RED;
}

export const STATUS_TONE: Readonly<Record<HealthStatus, Tone>> = {
  healthy: TONE_EMERALD,
  attention: TONE_AMBER,
  critical: TONE_RED,
  offline: TONE_ZINC,
};

export const STATUS_LABEL: Readonly<Record<HealthStatus, string>> = {
  healthy: "Healthy",
  attention: "Needs attention",
  critical: "Critical",
  offline: "Offline",
};

// ── Circular health gauge ─────────────────────────────────────────────────────
export function HealthGauge({
  score,
  size = 96,
  strokeWidth = 8,
  label,
}: {
  score: number;
  size?: number;
  strokeWidth?: number;
  label?: string;
}) {
  const reduced = useReducedMotion();
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const target = circumference * (1 - Math.max(0, Math.min(100, score)) / 100);
  const tone = healthTone(score);

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          className="stroke-zinc-200 dark:stroke-zinc-800"
        />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={tone.stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: reduced ? target : circumference }}
          animate={{ strokeDashoffset: target }}
          transition={{ duration: reduced ? 0 : 1.1, ease: EASE_OUT }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <AnimatedNumber value={score} className={cn("text-xl font-semibold tabular-nums", tone.text)} />
        {label ? <span className="mt-0.5 text-[10px] font-medium text-zinc-500 dark:text-zinc-400">{label}</span> : null}
      </div>
    </div>
  );
}

/** Compact ring used for Core Web Vitals / PageSpeed sub-scores. */
export function MiniGauge({ score, caption, unit }: { score: number; caption: string; unit?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      <HealthGauge score={score} size={64} strokeWidth={6} />
      <div className="text-center">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {caption}
          {unit ? <span className="ml-1 font-normal text-zinc-500 dark:text-zinc-400">{unit}</span> : null}
        </p>
      </div>
    </div>
  );
}

// ── 90-day uptime strip ───────────────────────────────────────────────────────
const DAY_TONE: Readonly<Record<DayStatus, string>> = {
  up: "bg-emerald-500/80",
  degraded: "bg-amber-500/90",
  down: "bg-red-500/90",
};

export function UptimeStrip({ days }: { days: readonly DayStatus[] }) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  return (
    <div ref={ref} className="flex items-end gap-[3px]" role="img" aria-label={`90-day uptime, ${days.length} days shown`}>
      {days.map((status, i) => (
        <motion.span
          key={i}
          title={`Day ${i + 1}: ${status}`}
          className={cn("h-8 flex-1 rounded-sm", DAY_TONE[status])}
          initial={reduced ? false : { opacity: 0, scaleY: 0.4 }}
          animate={inView ? { opacity: 1, scaleY: 1 } : undefined}
          transition={{ duration: 0.4, ease: EASE_OUT, delay: Math.min(i * 0.006, 0.5) }}
          style={{ transformOrigin: "bottom" }}
        />
      ))}
    </div>
  );
}

// ── SVG sparkline ─────────────────────────────────────────────────────────────
export function Sparkline({
  data,
  stroke = "#0ea5e9",
  width = 120,
  height = 32,
  fill = true,
}: {
  data: readonly number[];
  stroke?: string;
  width?: number;
  height?: number;
  fill?: boolean;
}) {
  const reduced = useReducedMotion();
  if (data.length === 0) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = width / (data.length - 1 || 1);
  const points = data.map((value, i) => {
    const x = i * step;
    const y = height - ((value - min) / range) * (height - 4) - 2;
    return [x, y] as const;
  });
  const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const gradientId = `spark-${Math.round(width)}-${stroke.replace("#", "")}`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible" aria-hidden>
      {fill ? (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.28} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gradientId})`} stroke="none" />
        </>
      ) : null}
      <motion.path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={reduced ? false : { pathLength: 0, opacity: 0.4 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: reduced ? 0 : 1, ease: EASE_OUT }}
      />
    </svg>
  );
}

// ── Severity badge ────────────────────────────────────────────────────────────
const SEVERITY_TONE: Readonly<Record<Severity, string>> = {
  critical: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  high: "border-orange-500/40 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  medium: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  low: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
};

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize", SEVERITY_TONE[severity])}>
      {severity}
    </span>
  );
}

// ── Delta pill ────────────────────────────────────────────────────────────────
export function DeltaPill({ value, positiveIsGood = true }: { value: number; positiveIsGood?: boolean }) {
  const up = value >= 0;
  const good = up === positiveIsGood;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
        good ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-red-500/10 text-red-600 dark:text-red-400",
      )}
    >
      {up ? "▲" : "▼"} {Math.abs(value)}%
    </span>
  );
}

// ── Progress ring (bulk update rows) ──────────────────────────────────────────
export function ProgressRing({ value, tone, size = 34 }: { value: number; tone: Tone; size?: number }) {
  const reduced = useReducedMotion();
  const strokeWidth = 4;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const target = circumference * (1 - value / 100);
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={strokeWidth} className="stroke-zinc-200 dark:stroke-zinc-800" />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={tone.stroke}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: reduced ? target : circumference }}
          animate={{ strokeDashoffset: target }}
          transition={{ duration: reduced ? 0 : 0.9, ease: EASE_OUT }}
        />
      </svg>
      <span className="absolute text-[9px] font-semibold tabular-nums text-zinc-600 dark:text-zinc-300">{value}</span>
    </div>
  );
}

// ── Section card + stat tile ──────────────────────────────────────────────────
export function SectionCard({
  title,
  description,
  icon: Icon,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  icon?: React.ElementType;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/60", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          {Icon ? (
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-zinc-200 bg-zinc-50 text-sky-600 dark:border-zinc-800 dark:bg-zinc-950/60 dark:text-sky-400">
              <Icon className="h-4 w-4" aria-hidden />
            </span>
          ) : null}
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
            {description ? <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">{description}</p> : null}
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  decimals = 0,
  prefix,
  suffix,
  icon: Icon,
  tone = TONE_SKY,
  delta,
  positiveIsGood = true,
  spark,
}: {
  label: string;
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  icon?: React.ElementType;
  tone?: Tone;
  delta?: number;
  positiveIsGood?: boolean;
  spark?: readonly number[];
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/60">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          {Icon ? (
            <span className={cn("grid h-6 w-6 place-items-center rounded-md", tone.soft, tone.text)}>
              <Icon className="h-3.5 w-3.5" aria-hidden />
            </span>
          ) : null}
          {label}
        </span>
        {delta !== undefined ? <DeltaPill value={delta} positiveIsGood={positiveIsGood} /> : null}
      </div>
      <div className="mt-3 flex items-end justify-between gap-2">
        <AnimatedNumber
          value={value}
          decimals={decimals}
          prefix={prefix}
          suffix={suffix}
          className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100"
        />
        {spark ? <Sparkline data={spark} stroke={tone.stroke} width={72} height={28} /> : null}
      </div>
    </div>
  );
}
