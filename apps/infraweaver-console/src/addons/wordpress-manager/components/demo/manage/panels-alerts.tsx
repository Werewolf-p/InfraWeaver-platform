"use client";

// Alerts panel — a derived, severity-ranked feed synthesized from live update,
// integrity, runtime and Connector signals. Read-only: no rules, no toggles.
import { AlertTriangle, BellRing, CheckCircle2, Info, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AlertItem, AlertSeverity, AlertsData } from "../../../lib/manage/probes/alerts";
import { SectionCard, StatTile, healthTone } from "../widgets";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize";

const SEVERITY_META: Readonly<
  Record<AlertSeverity, { pill: string; dot: string; icon: typeof AlertTriangle; label: string }>
> = {
  critical: {
    pill: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
    dot: "bg-red-500",
    icon: ShieldAlert,
    label: "Critical",
  },
  warning: {
    pill: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
    icon: AlertTriangle,
    label: "Warning",
  },
  info: {
    pill: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
    dot: "bg-sky-500",
    icon: Info,
    label: "Info",
  },
};

function AlertRow({ alert }: { alert: AlertItem }) {
  const meta = SEVERITY_META[alert.severity];
  return (
    <li className="flex items-start gap-3 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", meta.dot)} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{alert.title}</p>
          <span className={cn(PILL, meta.pill)}>{alert.severity}</span>
        </div>
        <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">{alert.detail}</p>
      </div>
      {alert.when ? (
        <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">
          {new Date(alert.when).toLocaleString()}
        </span>
      ) : null}
    </li>
  );
}

export function AlertsPanel({ site }: { site: string }) {
  const state = useManagePanel<AlertsData>(site, "alerts");

  return (
    <PanelState state={state}>
      {(data) => {
        const { alerts, counts } = data;
        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="grid gap-3 sm:grid-cols-3 lg:col-span-2">
              <StatTile
                label="Critical"
                value={counts.critical}
                icon={ShieldAlert}
                tone={healthTone(counts.critical === 0 ? 96 : 20)}
              />
              <StatTile
                label="Warnings"
                value={counts.warning}
                icon={AlertTriangle}
                tone={healthTone(counts.warning === 0 ? 96 : 55)}
              />
              <StatTile label="Info" value={counts.info} icon={Info} tone={healthTone(80)} />
            </div>

            <SectionCard
              className="lg:col-span-2"
              title="Alert feed"
              description={`${alerts.length} active alert${alerts.length === 1 ? "" : "s"} derived from live signals.`}
              icon={BellRing}
            >
              {alerts.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                  <CheckCircle2 className="h-6 w-6 text-emerald-500" aria-hidden />
                  No active alerts — every monitored signal is healthy.
                </div>
              ) : (
                <ul className="space-y-2">
                  {alerts.map((alert) => (
                    <AlertRow key={alert.id} alert={alert} />
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>
        );
      }}
    </PanelState>
  );
}
