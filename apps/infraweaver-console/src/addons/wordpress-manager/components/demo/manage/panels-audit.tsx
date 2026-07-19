"use client";

// A11y & SEO Audit tab for the per-site "Manage" demo console — WCAG issues and on-page SEO.
import { Accessibility, AlertTriangle, CheckCircle2, Search, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { CheckState } from "../site-manage-data";
import type { AuditIssue, SiteManageExt } from "../site-manage-ext-data";
import { HealthGauge, SectionCard } from "../widgets";
import { DummyBadge } from "../DummyBadge";

const PILL = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const IMPACT_TONE: Readonly<Record<AuditIssue["impact"], string>> = {
  critical: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  serious: "border-orange-500/30 bg-orange-500/10 text-orange-600 dark:text-orange-400",
  moderate: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  minor: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
};
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
const ROW_BTN =
  "shrink-0 rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";

const demo = () => toast.info("Demo — no changes are made to the live site.");

const CHECK_ICON: Readonly<Record<CheckState, { Icon: React.ElementType; cls: string }>> = {
  good: { Icon: CheckCircle2, cls: "text-emerald-500" },
  recommended: { Icon: AlertTriangle, cls: "text-amber-500" },
  critical: { Icon: XCircle, cls: "text-red-500" },
};

export function AuditPanel({ ext }: { ext: SiteManageExt; site: string }) {
  const { audit } = ext;
  const seoPassing = audit.seoChecks.filter((c) => c.state === "good").length;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <SectionCard
        title="Accessibility (WCAG 2.2)"
        description="Automated axe-core checks against Level AA."
        icon={Accessibility}
        action={
          <div className="flex items-center gap-2">
            <button type="button" onClick={demo} className={BTN}>
              Re-run audit
            </button>
            <DummyBadge />
          </div>
        }
      >
        <div className="flex flex-col items-start gap-4 sm:flex-row">
          <div className="mx-auto shrink-0 sm:mx-0">
            <HealthGauge score={audit.a11yScore} size={100} label="score" />
          </div>
          <div className="min-w-0 flex-1 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                  <th className="py-2 pr-4 font-medium">Rule</th>
                  <th className="py-2 pr-4 font-medium">Impact</th>
                  <th className="py-2 text-right font-medium">Count</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {audit.a11yIssues.map((issue) => (
                  <tr key={issue.rule} className="text-zinc-700 dark:text-zinc-300">
                    <td className="py-2 pr-4 text-zinc-900 dark:text-zinc-100">{issue.rule}</td>
                    <td className="py-2 pr-4">
                      <span className={cn(PILL, IMPACT_TONE[issue.impact])}>{issue.impact}</span>
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {issue.count === 0 ? (
                        <CheckCircle2 className="inline h-4 w-4 text-emerald-500" aria-label="No issues" />
                      ) : (
                        issue.count
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="SEO on-page audit"
        description={`${seoPassing} of ${audit.seoChecks.length} passing`}
        icon={Search}
        action={<DummyBadge />}
      >
        <div className="flex items-center gap-4">
          <HealthGauge score={audit.seoScore} label="score" />
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            On-page factors that influence search ranking and rich results.
          </p>
        </div>
        <ul className="mt-4 space-y-2">
          {audit.seoChecks.map((check) => {
            const { Icon, cls } = CHECK_ICON[check.state];
            return (
              <li
                key={check.label}
                className="flex items-start gap-2.5 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40"
              >
                <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", cls)} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{check.label}</p>
                  <p className="text-xs text-zinc-500">{check.detail}</p>
                </div>
                {check.state !== "good" ? (
                  <button type="button" onClick={demo} className={ROW_BTN}>
                    Fix
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      </SectionCard>
    </div>
  );
}
