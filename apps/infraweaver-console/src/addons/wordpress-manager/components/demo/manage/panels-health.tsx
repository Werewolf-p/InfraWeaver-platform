"use client";

// Health panel — a WordPress Site-Health-style checklist plus a versions summary,
// all read live from the site over core wp-cli. Read-only: no write buttons.
//
// The checklist now renders through the shared kit's Posture primitives
// (`PostureSummary` + `PostureCheck`) instead of a hand-rolled icon map. An overall
// verdict rides in a `Pill` in the card header, and the all-green / no-checks states
// fall back to the kit's `EmptyState`. Check order is preserved from the probe (its
// deliberate Site-Health narrative: core → integrity → plugins → PHP → HTTPS →
// debug → maintenance → cron).
import { HeartPulse, Server, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { HealthData } from "../../../lib/manage/probes/health";
import { SectionCard } from "../widgets";
import { EmptyState, Pill, PostureCheck, PostureSummary, type PillTone } from "./kit";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";

const TILE = "rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40";

/** One-line overall verdict for the card header, derived from the check counts. */
function overallStatus(recommended: number, critical: number): { readonly tone: PillTone; readonly label: string } {
  if (critical > 0) return { tone: "critical", label: "Critical" };
  if (recommended > 0) return { tone: "warn", label: "Needs attention" };
  return { tone: "good", label: "Healthy" };
}

export function HealthPanel({ site }: { site: string }) {
  const state = useManagePanel<HealthData>(site, "health");

  return (
    <PanelState state={state}>
      {(data) => {
        const { good, recommended, critical } = data.counts;
        const hasChecks = data.checks.length > 0;
        const allGood = hasChecks && recommended === 0 && critical === 0;
        const overall = overallStatus(recommended, critical);

        const envRows: ReadonlyArray<{ label: string; value: string }> = [
          { label: "WordPress", value: data.wp ?? "—" },
          { label: "PHP", value: data.php ?? "—" },
          { label: "Database size", value: data.dbSizeMb !== null ? `${data.dbSizeMb} MB` : "—" },
        ];

        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <SectionCard
              title="Site Health"
              description="Live checks across core, integrity, plugins, PHP, HTTPS and scheduled tasks."
              icon={HeartPulse}
              className="lg:col-span-2"
              action={hasChecks ? <Pill tone={overall.tone}>{overall.label}</Pill> : undefined}
            >
              {!hasChecks ? (
                <EmptyState
                  icon={HeartPulse}
                  title="No health checks"
                  body="This site didn't return any Site Health checks."
                />
              ) : allGood ? (
                <EmptyState
                  icon={ShieldCheck}
                  title="All checks passing"
                  body={`All ${good} Site Health checks are green — core, integrity, PHP, HTTPS and scheduled tasks look good.`}
                />
              ) : (
                <>
                  <PostureSummary good={good} recommended={recommended} critical={critical} />
                  <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                    {data.checks.map((check) => (
                      <PostureCheck key={check.id} state={check.state} label={check.label} detail={check.detail} />
                    ))}
                  </ul>
                </>
              )}
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
