"use client";

import Link from "next/link";
import { ArrowUpRight, Database, HardDrive } from "lucide-react";
import { useApiQuery } from "@/hooks/use-api-query";
import { cn } from "@/lib/utils";
import type { StorageVitals, StorageVitalsResponse } from "@/app/api/metrics/storage-vitals/route";

interface VitalTileProps {
  label: string;
  value: number | null;
  unit?: string;
  icon?: typeof HardDrive;
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
 * Live storage saturation straight from Prometheus (fullest PVC, PVCs near full,
 * cluster PVC usage, fullest node disk) plus the top offending PVCs. Self-contained
 * card — it owns its own query rather than threading through the board so the
 * Prometheus dependency stays isolated to this widget and degrades to a muted note
 * when the metrics backend is absent. Complements ClusterVitalsWidget (compute
 * saturation) and ResourcePressureWidget (memory/OOM) with the disk dimension.
 */
export function StorageVitalsWidget() {
  const query = useApiQuery<StorageVitalsResponse>({
    queryKey: ["observability", "storage-vitals"],
    path: "/api/metrics/storage-vitals",
    refetchInterval: 30_000,
    staleTime: 20_000,
    retry: false,
  });

  const vitals: StorageVitals | undefined = query.data?.available ? query.data.vitals : undefined;
  const fullestPvcs = query.data?.available ? query.data.fullestPvcs ?? [] : [];
  const unavailable = query.isError || (query.data && !query.data.available);

  return (
    <div className="flex h-full flex-col rounded-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-[#141414] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900 dark:text-white">
            <Database className="h-4 w-4 text-cyan-500" aria-hidden="true" />
            Storage Vitals
          </h3>
          <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-[#9e9e9e]">Live PVC & node-disk fill from Prometheus</p>
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
            <VitalTile label="Fullest PVC" value={vitals.maxPvcPct} unit="%" icon={Database} danger={{ warn: 80, crit: 90 }} />
            <VitalTile label="PVCs ≥80%" value={vitals.pvcsNearFull} danger={{ warn: 1, crit: 1 }} />
            <VitalTile label="Cluster PVC" value={vitals.clusterPvcPct} unit="%" danger={{ warn: 80, crit: 90 }} />
            <VitalTile label="Node disk" value={vitals.nodeDiskPct} unit="%" icon={HardDrive} danger={{ warn: 80, crit: 90 }} />
          </div>
          {fullestPvcs.length > 0 ? (
            <ul className="space-y-1 pt-1">
              {fullestPvcs.slice(0, 3).map((pvc) => (
                <li key={`${pvc.namespace}/${pvc.name}`} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate text-gray-700 dark:text-[#d4d4d4]">{pvc.namespace}/{pvc.name}</span>
                  <span className="shrink-0 tabular-nums text-gray-500 dark:text-[#888]">{pvc.pct}%</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      <Link href="/storage" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-cyan-500 hover:text-cyan-400">
        Storage
        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Link>
    </div>
  );
}
