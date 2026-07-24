"use client";

// Site Health surface — the WordPress-Site-Health checklist GROWN into one place
// that also covers reachability (broken links, 404s, redirects) and maintenance.
//
// The wp-cli checklist keeps working on every site (Free included); the
// connector-backed sub-sections light up only when the site's `health` snapshot
// carries them (`data.siteHealth`), degrading gracefully to just the checklist
// otherwise. All connector reads ride ONE signed `sitehealth.snapshot` folded into
// this panel's probe; writes go through the dedicated signed route + the
// maintenance orchestrator. Redirect creation is a single modal shared by the
// broken-link "Redirect this", the 404 "Accept", and the manager's "New redirect".
import { useState } from "react";
import { HeartPulse, Server, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { HealthData } from "../../../lib/manage/probes/health";
import { useSiteHealthActions } from "../../../lib/manage/use-site-health";
import { SectionCard } from "../widgets";
import { EmptyState, Pill, PostureCheck, PostureSummary, type PillTone } from "./kit";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";
import { RedirectCreateForm, type RedirectPrefill } from "../../manage/site-health/redirect-form";
import { Reachability } from "../../manage/site-health/reachability";
import { RedirectsManager } from "../../manage/site-health/redirects-manager";
import { MaintenanceCard } from "../../manage/site-health/maintenance-card";

const TILE = "rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40";

/** One-line overall verdict for the card header, derived from the check counts. */
function overallStatus(recommended: number, critical: number): { readonly tone: PillTone; readonly label: string } {
  if (critical > 0) return { tone: "critical", label: "Critical" };
  if (recommended > 0) return { tone: "warn", label: "Needs attention" };
  return { tone: "good", label: "Healthy" };
}

export function HealthPanel({ site }: { site: string }) {
  const state = useManagePanel<HealthData>(site, "health");
  const actions = useSiteHealthActions(site);
  const [createPrefill, setCreatePrefill] = useState<RedirectPrefill | null>(null);

  return (
    <PanelState state={state}>
      {(data) => {
        const { good, recommended, critical } = data.counts;
        const hasChecks = data.checks.length > 0;
        const allGood = hasChecks && recommended === 0 && critical === 0;
        const overall = overallStatus(recommended, critical);
        const sh = data.siteHealth ?? null;

        const envRows: ReadonlyArray<{ label: string; value: string }> = [
          { label: "WordPress", value: data.wp ?? "—" },
          { label: "PHP", value: data.php ?? "—" },
          { label: "Database size", value: data.dbSizeMb !== null ? `${data.dbSizeMb} MB` : "—" },
        ];

        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <SectionCard
              title="Checklist"
              description="Live checks across core, integrity, plugins, PHP, HTTPS and scheduled tasks."
              icon={HeartPulse}
              className="lg:col-span-2"
              action={hasChecks ? <Pill tone={overall.tone}>{overall.label}</Pill> : undefined}
            >
              {!hasChecks ? (
                <EmptyState icon={HeartPulse} title="No health checks" body="This site didn't return any Site Health checks." />
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

            {sh ? (
              <div className="grid gap-5 lg:col-span-2">
                <Reachability
                  links={sh.links}
                  notfound={sh.notfound}
                  suggestions={sh.suggestions}
                  actions={actions}
                  onRequestRedirect={(source, target) => setCreatePrefill({ source, target })}
                />
                <RedirectsManager
                  site={site}
                  enabled
                  locked={sh.redirects.locked}
                  actions={actions}
                  onNewRedirect={() => setCreatePrefill({})}
                />
                <MaintenanceCard maintenance={sh.maintenance} actions={actions} />
              </div>
            ) : (
              <p className="text-xs text-zinc-500 lg:col-span-2 dark:text-zinc-400">
                Link this site's InfraWeaver Connector to unlock broken-link scanning, redirects and maintenance mode here.
              </p>
            )}

            <RedirectCreateForm
              open={createPrefill !== null}
              initial={createPrefill}
              onClose={() => setCreatePrefill(null)}
              onSubmit={actions.createRedirect}
            />
          </div>
        );
      }}
    </PanelState>
  );
}
