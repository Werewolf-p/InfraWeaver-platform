"use client";
// Clients & Care panel — a care-plan scorecard derived from live Connector + maintenance signals.

import { Activity, AlertTriangle, CheckCircle2, ClipboardCheck, HelpCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CareStatus, ClientsData } from "../../../lib/manage/probes/clients";
import { HealthGauge, SectionCard, StatTile, healthTone } from "../widgets";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const TONE_PILL = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
} as const;
const TILE = "rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40";

const STATUS_META: Readonly<Record<CareStatus, { icon: typeof CheckCircle2; className: string; label: string }>> = {
  ok: { icon: CheckCircle2, className: "text-emerald-500", label: "Healthy" },
  attention: { icon: AlertTriangle, className: "text-amber-500", label: "Attention" },
  critical: { icon: AlertTriangle, className: "text-red-500", label: "Critical" },
  unknown: { icon: HelpCircle, className: "text-zinc-400", label: "Unknown" },
};

const STATUS_PILL: Readonly<Record<CareStatus, string>> = {
  ok: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  attention: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  critical: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  unknown: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function ClientsPanel({ site }: { site: string }) {
  const state = useManagePanel<ClientsData>(site, "clients");

  return (
    <PanelState state={state}>
      {(data) => {
        const pendingUpdates = (data.maintenance.coreUpdate ? 1 : 0) + data.maintenance.pluginUpdates;
        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <SectionCard
              title="Care status"
              description="Rolled up from live Connector and maintenance signals."
              icon={ShieldCheck}
            >
              <div className="flex items-center gap-4">
                <HealthGauge score={data.score} size={96} strokeWidth={8} label="care" />
                <div className="min-w-0 space-y-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn(PILL, data.connection.state === "active" ? TONE_PILL.good : TONE_PILL.neutral)}>
                      {data.connection.state ?? "unlinked"}
                    </span>
                    {data.connection.fingerprintConfirmed ? (
                      <span className={cn(PILL, TONE_PILL.info)}>fingerprint confirmed</span>
                    ) : null}
                  </div>
                  <p className="text-zinc-600 dark:text-zinc-400">
                    Connector{" "}
                    <span className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300">
                      {data.connection.connectorVersion ?? "—"}
                    </span>
                  </p>
                  <p className="text-zinc-600 dark:text-zinc-400">Managed since {formatDate(data.managedSince)}</p>
                </div>
              </div>
            </SectionCard>

            <SectionCard title="Signals" description="Live maintenance and link telemetry." icon={Activity}>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <StatTile
                  label="Pending updates"
                  value={pendingUpdates}
                  tone={healthTone(pendingUpdates === 0 ? 92 : pendingUpdates <= 3 ? 68 : 40)}
                />
                <StatTile
                  label="Round-trip"
                  value={data.connection.roundtripMs ?? 0}
                  suffix=" ms"
                  tone={healthTone(data.connection.lastCheckOk ? 85 : 45)}
                />
                <StatTile
                  label="Rejections"
                  value={data.security.rejections}
                  tone={healthTone(data.security.rejections === 0 ? 92 : 45)}
                />
              </div>
              <div className={cn(TILE, "mt-3 flex items-center justify-between gap-2")}>
                <span className="flex items-center gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-400">
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Last key reroll
                </span>
                <span className="text-sm text-zinc-900 dark:text-zinc-100">{formatDate(data.lastReroll)}</span>
              </div>
            </SectionCard>

            <SectionCard
              title="Care checks"
              description="Derived from real update, integrity and connection state."
              icon={ClipboardCheck}
              className="lg:col-span-2"
            >
              <ul className="space-y-2">
                {data.checks.map((check) => {
                  const meta = STATUS_META[check.status];
                  const Icon = meta.icon;
                  return (
                    <li key={check.id} className={cn(TILE, "flex items-center gap-3")}>
                      <Icon className={cn("h-4 w-4 shrink-0", meta.className)} aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{check.label}</p>
                        <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">{check.detail}</p>
                      </div>
                      <span className={cn(PILL, STATUS_PILL[check.status])}>{meta.label}</span>
                    </li>
                  );
                })}
              </ul>
            </SectionCard>
          </div>
        );
      }}
    </PanelState>
  );
}
