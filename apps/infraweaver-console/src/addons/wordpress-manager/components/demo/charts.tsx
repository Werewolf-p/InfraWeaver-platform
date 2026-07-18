"use client";

import { useReducedMotion } from "framer-motion";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  BackupPoint,
  PerfPoint,
  PhpPoint,
  ResponsePoint,
  Severity,
  TrafficPoint,
  UpdatesPoint,
  WafPoint,
} from "./dummy-data";

// Colours chosen to read on BOTH light and dark backgrounds.
const AXIS = "#71717a"; // zinc-500
const GRID = "rgba(113,113,122,0.16)";
const COLORS = {
  core: "#0ea5e9",
  plugins: "#8b5cf6",
  themes: "#f59e0b",
  blocked: "#ef4444",
  backup: "#10b981",
  mobile: "#f59e0b",
  desktop: "#0ea5e9",
  traffic: "#0ea5e9",
  php: "#ef4444",
  response: "#8b5cf6",
} as const;

const SEVERITY_FILL: Readonly<Record<Severity, string>> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#f59e0b",
  low: "#0ea5e9",
};

const AXIS_TICK = { fill: AXIS, fontSize: 11 } as const;

// ── Theme-aware tooltip ───────────────────────────────────────────────────────
interface TooltipItem {
  name?: string;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
}
interface ChartTooltipProps {
  active?: boolean;
  payload?: readonly TooltipItem[];
  label?: string | number;
  unit?: string;
  labelPrefix?: string;
}

function ChartTooltip({ active, payload, label, unit, labelPrefix }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-lg border border-zinc-200 bg-white/95 px-3 py-2 text-xs shadow-lg backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95">
      {label !== undefined ? (
        <p className="mb-1 font-medium text-zinc-500 dark:text-zinc-400">
          {labelPrefix}
          {label}
        </p>
      ) : null}
      {payload.map((entry, i) => (
        <p key={i} className="flex items-center gap-2 text-zinc-900 dark:text-zinc-100">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} aria-hidden />
          <span className="capitalize text-zinc-600 dark:text-zinc-400">{entry.name}</span>
          <span className="ml-auto font-semibold tabular-nums">
            {entry.value}
            {unit ? ` ${unit}` : ""}
          </span>
        </p>
      ))}
    </div>
  );
}

function ChartFrame({ height = 220, children }: { height?: number; children: React.ReactElement }) {
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

// ── Pending updates (stacked bar) ─────────────────────────────────────────────
export function UpdatesStackedBar({ data }: { data: readonly UpdatesPoint[] }) {
  const reduced = useReducedMotion();
  return (
    <ChartFrame height={220}>
      <BarChart data={[...data]} margin={{ top: 4, right: 4, bottom: 0, left: -18 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip cursor={{ fill: "rgba(113,113,122,0.08)" }} content={<ChartTooltip />} />
        <Bar dataKey="core" stackId="u" fill={COLORS.core} radius={[0, 0, 0, 0]} isAnimationActive={!reduced} />
        <Bar dataKey="plugins" stackId="u" fill={COLORS.plugins} isAnimationActive={!reduced} />
        <Bar dataKey="themes" stackId="u" fill={COLORS.themes} radius={[4, 4, 0, 0]} isAnimationActive={!reduced} />
      </BarChart>
    </ChartFrame>
  );
}

// ── Response time (line) ──────────────────────────────────────────────────────
export function ResponseTimeLine({ data }: { data: readonly ResponsePoint[] }) {
  const reduced = useReducedMotion();
  return (
    <ChartFrame height={200}>
      <LineChart data={[...data]} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="t" tick={AXIS_TICK} axisLine={false} tickLine={false} interval={3} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} />
        <Tooltip content={<ChartTooltip unit="ms" />} />
        <Line
          type="monotone"
          dataKey="ms"
          name="Response"
          stroke={COLORS.response}
          strokeWidth={2}
          dot={false}
          isAnimationActive={!reduced}
        />
      </LineChart>
    </ChartFrame>
  );
}

// ── Backup size (area) ────────────────────────────────────────────────────────
export function BackupAreaChart({ data }: { data: readonly BackupPoint[] }) {
  const reduced = useReducedMotion();
  return (
    <ChartFrame height={180}>
      <AreaChart data={[...data]} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
        <defs>
          <linearGradient id="backupFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COLORS.backup} stopOpacity={0.35} />
            <stop offset="100%" stopColor={COLORS.backup} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="day" tick={AXIS_TICK} axisLine={false} tickLine={false} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={44} />
        <Tooltip content={<ChartTooltip unit="GB" />} />
        <Area
          type="monotone"
          dataKey="sizeGb"
          name="Backup"
          stroke={COLORS.backup}
          strokeWidth={2}
          fill="url(#backupFill)"
          isAnimationActive={!reduced}
        />
      </AreaChart>
    </ChartFrame>
  );
}

// ── WAF blocked requests (area) ───────────────────────────────────────────────
export function WafAreaChart({ data }: { data: readonly WafPoint[] }) {
  const reduced = useReducedMotion();
  return (
    <ChartFrame height={200}>
      <AreaChart data={[...data]} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
        <defs>
          <linearGradient id="wafFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COLORS.blocked} stopOpacity={0.32} />
            <stop offset="100%" stopColor={COLORS.blocked} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="t" tick={AXIS_TICK} axisLine={false} tickLine={false} interval={3} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={40} />
        <Tooltip content={<ChartTooltip />} />
        <Area
          type="monotone"
          dataKey="blocked"
          name="Blocked"
          stroke={COLORS.blocked}
          strokeWidth={2}
          fill="url(#wafFill)"
          isAnimationActive={!reduced}
        />
      </AreaChart>
    </ChartFrame>
  );
}

// ── Malware scan (donut) ──────────────────────────────────────────────────────
export function MalwareDonut({ clean, flagged }: { clean: number; flagged: number }) {
  const reduced = useReducedMotion();
  const data = [
    { name: "Clean", value: clean, fill: COLORS.backup },
    { name: "Flagged", value: flagged, fill: COLORS.blocked },
  ];
  return (
    <div className="relative">
      <ChartFrame height={200}>
        <PieChart>
          <Tooltip content={<ChartTooltip />} />
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius="62%"
            outerRadius="86%"
            paddingAngle={2}
            stroke="none"
            isAnimationActive={!reduced}
          >
            {data.map((entry) => (
              <Cell key={entry.name} fill={entry.fill} />
            ))}
          </Pie>
        </PieChart>
      </ChartFrame>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{clean}</span>
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">of {clean + flagged} clean</span>
      </div>
    </div>
  );
}

// ── PageSpeed trend (dual line) ───────────────────────────────────────────────
export function PageSpeedTrend({ data }: { data: readonly PerfPoint[] }) {
  const reduced = useReducedMotion();
  return (
    <ChartFrame height={200}>
      <LineChart data={[...data]} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="t" tick={AXIS_TICK} axisLine={false} tickLine={false} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} domain={[0, 100]} width={32} />
        <Tooltip content={<ChartTooltip />} />
        <Line type="monotone" dataKey="mobile" name="Mobile" stroke={COLORS.mobile} strokeWidth={2} dot={false} isAnimationActive={!reduced} />
        <Line type="monotone" dataKey="desktop" name="Desktop" stroke={COLORS.desktop} strokeWidth={2} dot={false} isAnimationActive={!reduced} />
      </LineChart>
    </ChartFrame>
  );
}

// ── Traffic (area) ────────────────────────────────────────────────────────────
export function TrafficArea({ data }: { data: readonly TrafficPoint[] }) {
  const reduced = useReducedMotion();
  return (
    <ChartFrame height={200}>
      <AreaChart data={[...data]} margin={{ top: 4, right: 8, bottom: 0, left: -6 }}>
        <defs>
          <linearGradient id="trafficFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COLORS.traffic} stopOpacity={0.35} />
            <stop offset="100%" stopColor={COLORS.traffic} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="t" tick={AXIS_TICK} axisLine={false} tickLine={false} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} />
        <Tooltip content={<ChartTooltip />} />
        <Area type="monotone" dataKey="visitors" name="Visitors" stroke={COLORS.traffic} strokeWidth={2} fill="url(#trafficFill)" isAnimationActive={!reduced} />
      </AreaChart>
    </ChartFrame>
  );
}

// ── PHP errors (line) ─────────────────────────────────────────────────────────
export function PhpErrorLine({ data }: { data: readonly PhpPoint[] }) {
  const reduced = useReducedMotion();
  return (
    <ChartFrame height={180}>
      <LineChart data={[...data]} margin={{ top: 4, right: 8, bottom: 0, left: -22 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} vertical={false} />
        <XAxis dataKey="t" tick={AXIS_TICK} axisLine={false} tickLine={false} interval={3} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} width={36} />
        <Tooltip content={<ChartTooltip />} />
        <Line type="monotone" dataKey="errors" name="Errors" stroke={COLORS.php} strokeWidth={2} dot={false} isAnimationActive={!reduced} />
      </LineChart>
    </ChartFrame>
  );
}

// ── CVE severity (horizontal bar) ─────────────────────────────────────────────
export function CveSeverityBar({ counts }: { counts: Readonly<Record<Severity, number>> }) {
  const reduced = useReducedMotion();
  const data = (["critical", "high", "medium", "low"] as const).map((severity) => ({
    severity,
    count: counts[severity],
    fill: SEVERITY_FILL[severity],
  }));
  return (
    <ChartFrame height={160}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={GRID} horizontal={false} />
        <XAxis type="number" tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} />
        <YAxis type="category" dataKey="severity" tick={AXIS_TICK} axisLine={false} tickLine={false} width={64} tickFormatter={(v: string) => v.charAt(0).toUpperCase() + v.slice(1)} />
        <Tooltip cursor={{ fill: "rgba(113,113,122,0.08)" }} content={<ChartTooltip />} />
        <Bar dataKey="count" name="CVEs" radius={[0, 4, 4, 0]} isAnimationActive={!reduced}>
          {data.map((entry) => (
            <Cell key={entry.severity} fill={entry.fill} />
          ))}
        </Bar>
      </BarChart>
    </ChartFrame>
  );
}
