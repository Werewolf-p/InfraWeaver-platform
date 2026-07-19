"use client";

// Health panel — a WordPress Site-Health-style checklist plus a versions summary,
// all read live from the site over core wp-cli. Read-only: no write buttons.
import type { ElementType } from "react";
import { AlertTriangle, CheckCircle2, HeartPulse, Server, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CheckState, HealthData } from "../../../lib/manage/probes/health";
import { SectionCard } from "../widgets";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";

const TILE = "rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40";

const STATE_ICON: Readonly<Record<CheckState, { icon: ElementType; className: string }>> = {
  good: { icon: CheckCircle2, className: "text-emerald-500" },
  recommended: { icon: AlertTriangle, className: "text-amber-500" },
  critical: { icon: XCircle, className: "text-red-500" },
};

export function HealthPanel({ site }: { site: string }) {
  const state = useManagePanel<HealthData>(site, "health");

  return (
    <PanelState state={state}>
      {(data) => {
        const { good, recommended, critical } = data.counts;
        const envRows: ReadonlyArray<{ label: string; value: string }> = [
          { label: "WordPress", value: data.wp ?? "—" },
          { label: "PHP", value: data.php ?? "—" },
          { label: "Database size", value: data.dbSizeMb !== null ? `${data.dbSizeMb} MB` : "—" },
        ];

        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <SectionCard
              title="Site Health"
              description={`${good} good · ${recommended} recommended · ${critical} critical`}
              icon={HeartPulse}
              className="lg:col-span-2"
            >
              <ul className="grid gap-2 sm:grid-cols-2">
                {data.checks.map((check) => {
                  const { icon: Icon, className } = STATE_ICON[check.state];
                  return (
                    <li key={check.id} className={cn(TILE, "flex items-start gap-3")}>
                      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", className)} aria-hidden />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{check.label}</p>
                        <p className="text-sm text-zinc-600 dark:text-zinc-400">{check.detail}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </SectionCard>

            <SectionCard title="Environment" description="WordPress, PHP and database facts." icon={Server} className="lg:col-span-2">
              <div className="grid gap-3 sm:grid-cols-3">
                {envRows.map((row) => (
                  <div key={row.label} className={cn(TILE, "flex items-center justify-between gap-3")}>
                    <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{row.label}</span>
                    <span className="font-mono text-[11px] text-zinc-900 dark:text-zinc-100">{row.value}</span>
                  </div>
                ))}
              </div>
            </SectionCard>
          </div>
        );
      }}
    </PanelState>
  );
}
