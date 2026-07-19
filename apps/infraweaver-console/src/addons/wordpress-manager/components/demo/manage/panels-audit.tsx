"use client";

// A11y & SEO Audit panel — real findings computed live from wp-cli: image alt-text
// coverage (accessibility) and Yoast on-page SEO coverage. Every count is measured,
// not canned. Read-only: no allow-listed mutation exists, so there are no actions.

import { Accessibility, CheckCircle2, Info, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AuditData, AuditFinding, AuditSeverity } from "../../../lib/manage/probes/audit";
import { HealthGauge, SectionCard } from "../widgets";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize";
const IMPACT_TONE: Readonly<Record<AuditSeverity, string>> = {
  critical: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  serious: "border-orange-500/30 bg-orange-500/10 text-orange-600 dark:text-orange-400",
  moderate: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  minor: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
};

function FindingRow({ finding }: { finding: AuditFinding }) {
  const passing = finding.count === 0;
  return (
    <li className="flex items-start gap-2.5 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      {passing ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
      ) : (
        <span className={cn("mt-0.5", PILL, IMPACT_TONE[finding.severity])}>{finding.severity}</span>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{finding.label}</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{finding.detail}</p>
      </div>
      <span className="shrink-0 text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
        {passing ? <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-label="No issues" /> : finding.count.toLocaleString("en-US")}
      </span>
    </li>
  );
}

export function AuditPanel({ site }: { site: string }) {
  const state = useManagePanel<AuditData>(site, "audit");

  return (
    <PanelState state={state}>
      {(data) => {
        const a11yFindings = data.findings.filter((f) => f.category === "a11y");
        const seoFindings = data.findings.filter((f) => f.category === "seo");
        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <SectionCard
              className="lg:col-span-2"
              title="Audit score"
              description="Blended on-page SEO and accessibility coverage, computed from live site data."
              icon={CheckCircle2}
            >
              <div className="flex flex-wrap items-center gap-6">
                <HealthGauge score={data.score} size={104} label="overall" />
                <div className="grid flex-1 grid-cols-2 gap-3 sm:max-w-sm">
                  <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-center dark:border-zinc-800 dark:bg-zinc-950/40">
                    <p className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{data.a11yScore}</p>
                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">Accessibility</p>
                  </div>
                  <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-center dark:border-zinc-800 dark:bg-zinc-950/40">
                    <p className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                      {data.seoScore === null ? "—" : data.seoScore}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">On-page SEO</p>
                  </div>
                </div>
              </div>
            </SectionCard>

            <SectionCard
              title="Accessibility"
              description="Image alt-text coverage across the media library."
              icon={Accessibility}
            >
              <ul className="space-y-2">
                {a11yFindings.map((finding) => (
                  <FindingRow key={finding.id} finding={finding} />
                ))}
              </ul>
              <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
                {data.imageAttachments.toLocaleString("en-US")} image attachment
                {data.imageAttachments === 1 ? "" : "s"} in the library.
              </p>
            </SectionCard>

            <SectionCard title="On-page SEO" description="Yoast metadata coverage across published posts." icon={Search}>
              {data.yoast ? (
                <ul className="space-y-2">
                  {seoFindings.map((finding) => (
                    <FindingRow key={finding.id} finding={finding} />
                  ))}
                </ul>
              ) : (
                <div className="flex items-start gap-2.5 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3 text-sm text-zinc-700 dark:text-zinc-200">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-500" aria-hidden />
                  <p>
                    On-page SEO findings are derived from Yoast SEO metadata. Yoast isn&apos;t the active SEO plugin here, so
                    these checks are skipped rather than reported as total misses.
                  </p>
                </div>
              )}
            </SectionCard>
          </div>
        );
      }}
    </PanelState>
  );
}
