"use client";

// Security panel — a real posture checklist and a computed 0–100 score, sourced
// only from facts the site can honestly answer over core wp-cli (core integrity,
// core currency, admin exposure, hardening flags, salts, TLS, debug). Anything that
// would need a security plugin is omitted rather than faked. Read-only.
import { AlertTriangle, CheckCircle2, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CheckState, SecurityData } from "../../../lib/manage/probes/security";
import { HealthGauge, SectionCard, healthTone } from "../widgets";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";

const CHECK_ICON: Readonly<Record<CheckState, { Icon: React.ElementType; cls: string }>> = {
  good: { Icon: CheckCircle2, cls: "text-emerald-500" },
  recommended: { Icon: AlertTriangle, cls: "text-amber-500" },
  critical: { Icon: XCircle, cls: "text-red-500" },
};

export function SecurityPanel({ site }: { site: string }) {
  const state = useManagePanel<SecurityData>(site, "security");

  return (
    <PanelState state={state}>
      {(data) => {
        const { good, recommended, critical } = data.counts;
        const tone = healthTone(data.score);
        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <SectionCard title="Security posture" description="Score derived from the checks below." icon={ShieldCheck}>
              <div className="flex items-center gap-5">
                <HealthGauge score={data.score} size={104} strokeWidth={9} label="posture" />
                <dl className="space-y-1.5 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" aria-hidden />
                    <dt className="text-zinc-600 dark:text-zinc-400">Good</dt>
                    <dd className={cn("ml-auto tabular-nums font-medium", tone.text)}>{good}</dd>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-amber-500" aria-hidden />
                    <dt className="text-zinc-600 dark:text-zinc-400">Recommended</dt>
                    <dd className="ml-auto tabular-nums font-medium text-amber-600 dark:text-amber-400">{recommended}</dd>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-red-500" aria-hidden />
                    <dt className="text-zinc-600 dark:text-zinc-400">Critical</dt>
                    <dd className="ml-auto tabular-nums font-medium text-red-600 dark:text-red-400">{critical}</dd>
                  </div>
                </dl>
              </div>
            </SectionCard>

            <SectionCard title="Administrator exposure" description="Full-access accounts on this site." icon={ShieldAlert}>
              <div className="flex h-full flex-col items-center justify-center gap-1 rounded-xl border border-zinc-200 bg-zinc-50 p-6 dark:border-zinc-800 dark:bg-zinc-950/40">
                <span className="text-4xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{data.adminCount}</span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">
                  administrator account{data.adminCount === 1 ? "" : "s"}
                </span>
              </div>
            </SectionCard>

            <SectionCard
              className="lg:col-span-2"
              title="Hardening checks"
              description={`${good} of ${data.checks.length} checks passing`}
              icon={ShieldCheck}
            >
              <ul className="grid gap-2 sm:grid-cols-2">
                {data.checks.map((check) => {
                  const { Icon, cls } = CHECK_ICON[check.state];
                  return (
                    <li
                      key={check.id}
                      className="flex items-start gap-2.5 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40"
                    >
                      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", cls)} aria-hidden />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{check.label}</p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">{check.detail}</p>
                      </div>
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
