"use client";

// Security panel — a real posture checklist and a computed 0–100 score, sourced
// only from facts the site can honestly answer over core wp-cli (core integrity,
// core currency, admin exposure, hardening flags, salts, TLS, debug). Anything that
// would need a security plugin is omitted rather than faked. Read-only.
//
// The checklist now renders through the shared kit's Posture primitives
// (`PostureSummary` + `PostureCheck`) instead of a hand-rolled icon map — the same
// consolidation the Health panel uses. Checks are ordered scary-first
// (critical → recommended → good) so the most urgent items lead. There is no
// in-panel navigation handle here (the section rail lives in `manage-view.tsx` and
// only the Overview landing receives `onNavigate`), so remediation guidance stays
// honest in each check's `detail` rather than behind a link that cannot navigate.
import { ShieldAlert, ShieldCheck } from "lucide-react";
import type { CheckState, SecurityData } from "../../../lib/manage/probes/security";
import { HealthGauge, SectionCard } from "../widgets";
import { PostureCheck, PostureSummary } from "./kit";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";

/** Scary-first ordering for the checklist: critical → recommended → good. */
const STATE_ORDER: Readonly<Record<CheckState, number>> = { critical: 0, recommended: 1, good: 2 };

export function SecurityPanel({ site }: { site: string }) {
  const state = useManagePanel<SecurityData>(site, "security");

  return (
    <PanelState state={state}>
      {(data) => {
        const { good, recommended, critical } = data.counts;
        // Immutable copy — never sort the query-cached array in place.
        const sortedChecks = [...data.checks].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);
        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <SectionCard title="Security posture" description="Score derived from the checks below." icon={ShieldCheck}>
              <div className="flex items-center gap-5">
                <HealthGauge score={data.score} size={104} strokeWidth={9} label="posture" />
                <PostureSummary good={good} recommended={recommended} critical={critical} />
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
                {sortedChecks.map((check) => (
                  <PostureCheck key={check.id} state={check.state} label={check.label} detail={check.detail} />
                ))}
              </ul>
            </SectionCard>
          </div>
        );
      }}
    </PanelState>
  );
}
