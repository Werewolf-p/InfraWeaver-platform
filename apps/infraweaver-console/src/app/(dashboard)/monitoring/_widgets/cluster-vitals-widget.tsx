"use client";

import Link from "next/link";
import { Activity, ArrowUpRight, Cpu, MemoryStick } from "lucide-react";
import { useApiQuery } from "@/hooks/use-api-query";
import { cn } from "@/lib/utils";
import type { ClusterVitals, ClusterVitalsResponse } from "@/app/api/metrics/cluster-vitals/route";

interface VitalTileProps {
  label: string;
  value: number | null;
  unit?: string;
  icon?: typeof Cpu;
  /** Utilisation percent that turns the tile amber/red; omit for count tiles. */
  danger?: { warn: number; crit: number };
}

function tone(value: number | null, danger?: VitalTileProps["danger"]): "ok" | "warn" | "crit" {
  if (value === null || !danger) return "ok";
  if (value >= danger.crit) return "crit";
  if (value >= danger.warn) return "warn";
  return "ok";
}

function VitalTile({ label, value, unit, icon: Icon, danger }: VitalTileProps) {
  const t = tone(value, danger);
  const valueColor =
    t === "crit"
      ? "text-red-500"
      : t === "warn"
        ? "text-amber-500"
        : "text-gray-900 dark:text-white";
  return (
    <div className="rounded-xl border border-gray-200 dark:border-white/5 bg-gray-50 dark:bg-slate-950/40 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-gray-500 dark:text-[#888]">
        {Icon ? <Icon className="h-3 w-3" aria-hidden="true" /> : null}
        <span className="truncate">{label}</span>
      </div>
      <p className={cn("mt-0.5 text-lg font-bold tabular-nums", valueColor)}>
        {value === null ? "—" : value}
        {value !== null && unit ? <span className="ml-0.5 text-xs font-medium text-gray-400 dark:text-[#888]">{unit}</span> : null}
      </p>
    </div>
  );
}

/**
 * Live cluster vitals straight from Prometheus (CPU/mem saturation, running pods,
 * firing alerts, ingress throughput + error rate). Self-contained card — it owns
 * its own query rather than threading through the board so the Prometheus
 * dependency stays isolated to this widget and degrades to a muted note when the
 * metrics backend is absent.
 */
export function ClusterVitalsWidget() {
  const query = useApiQuery<ClusterVitalsResponse>({
    queryKey: ["observability", "cluster-vitals"],
    path: "/api/metrics/cluster-vitals",
    refetchInterval: 30_000,
    staleTime: 20_000,
    retry: false,
  });

  const vitals: ClusterVitals | undefined = query.data?.available ? query.data.vitals : undefined;
  const unavailable = query.isError || (query.data && !query.data.available);

  return (
    <div className="flex h-full flex-col rounded-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#141414] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-white">
            <Activity className="h-4 w-4 text-cyan-500" aria-hidden="true" />
            Cluster Vitals
          </h3>
          <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-[#9e9e9e]">Live saturation & ingress from Prometheus</p>
        </div>
      </div>

      {query.isLoading ? (
        <div className="mt-4 h-24 animate-pulse rounded-xl bg-gray-100 dark:bg-white/5" />
      ) : unavailable || !vitals ? (
        <p className="mt-3 flex-1 text-xs text-gray-500 dark:text-[#888]">
          Prometheus metrics are unavailable. Set <code className="font-mono">PROMETHEUS_URL</code> to enable live vitals.
        </p>
      ) : (
        <div className="mt-3 flex-1 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <VitalTile label="CPU" value={vitals.cpuPct} unit="%" icon={Cpu} danger={{ warn: 75, crit: 90 }} />
            <VitalTile label="Memory" value={vitals.memPct} unit="%" icon={MemoryStick} danger={{ warn: 80, crit: 92 }} />
            <VitalTile label="Running pods" value={vitals.runningPods} />
            <VitalTile label="Firing alerts" value={vitals.firingAlerts} danger={{ warn: 1, crit: 1 }} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <VitalTile label="Ingress" value={vitals.ingressReqPerSec} unit="req/s" />
            <VitalTile label="5xx rate" value={vitals.ingressErrorPct} unit="%" danger={{ warn: 1, crit: 5 }} />
          </div>
        </div>
      )}

      <Link href="/node-top" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-cyan-500 hover:text-cyan-400">
        Node metrics
        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </div>
  );
}
