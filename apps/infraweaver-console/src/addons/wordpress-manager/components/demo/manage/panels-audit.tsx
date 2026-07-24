"use client";

/**
 * The SEO cockpit — the anti-silo core. One surface where the site's SEO score is
 * ENGINE-AWARE (our SEO Suite / Meta Audit, or a third-party plugin), every number
 * is actionable, and the sitemap/robots/schema posture is at a glance.
 *
 *  - Score header: a traffic-light gauge labelled by the engine that measured it —
 *    never "Activate Yoast" to a site paying for our own SEO Suite (A3).
 *  - Glance cards: sitemap live + URL, robots managed, structured-data coverage,
 *    noindex count — the honest "is my site findable" panel (A4/D1).
 *  - Findings: real, measured issues (alt coverage, missing descriptions, keyphrase
 *    gaps, two-engine conflict, whole-site invisibility).
 *  - On-page audit + one-click fixes (`SeoAuditMap`, gated Pro) and alt-text backfill
 *    (`SeoAltBackfill`, gated Ultimate) — where the numbers become verbs.
 *
 * Data is the engine-aware `audit` probe (which merges the signed `seo.status`
 * snapshot over the wp-cli fallback); the interactive run/fix/backfill ride the
 * dedicated signed route. Locked features render an honest TierGate upsell.
 */

import { Accessibility, CheckCircle2, FileSearch, Globe, Info, Search, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AuditData, AuditFinding, AuditSeverity } from "../../../lib/manage/probes/audit";
import { HealthGauge, SectionCard } from "../widgets";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";
import { TierGate } from "../../manage/kit/tier-gate";
import { SeoAltBackfill, SeoAuditMap } from "../../manage/seo/seo-audit-map";

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

/** A compact "is my site findable" glance card. */
function GlanceCard({ icon: Icon, label, value, tone }: { icon: React.ElementType; label: string; value: string; tone: "good" | "warn" | "neutral" }) {
  const toneClass =
    tone === "good"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : "text-zinc-500 dark:text-zinc-400";
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      <div className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">
        <Icon className={cn("h-3.5 w-3.5", toneClass)} aria-hidden />
        {label}
      </div>
      <p className={cn("mt-1.5 text-sm font-semibold", toneClass)}>{value}</p>
    </div>
  );
}

function VisibilityGlance({ data }: { data: AuditData }) {
  const status = data.status;
  if (!status) return null;
  const suite = status.engines.suite;
  const sitemapValue = suite.sitemap.active ? "Live" : "Off";
  const schema = status.schema;
  return (
    <SectionCard title="Findability" description="Sitemap, robots and structured-data posture at a glance." icon={Globe}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <GlanceCard icon={Globe} label="XML sitemap" value={sitemapValue} tone={suite.sitemap.active ? "good" : "neutral"} />
        <GlanceCard icon={ShieldAlert} label="Noindexed" value={status.noindexed.toLocaleString("en-US")} tone={status.noindexed > 0 ? "warn" : "good"} />
        <GlanceCard icon={FileSearch} label="Robots managed" value={suite.robots_managed ? "Yes" : "No"} tone={suite.robots_managed ? "good" : "neutral"} />
        <GlanceCard
          icon={Search}
          label="Structured data"
          value={schema ? `${schema.typed_posts}/${schema.published} typed` : "—"}
          tone={schema && schema.site_representation ? "good" : "neutral"}
        />
      </div>
      {suite.sitemap.active && suite.sitemap.url ? (
        <p className="mt-2 truncate text-xs text-zinc-500 dark:text-zinc-400">Sitemap: {suite.sitemap.url}</p>
      ) : null}
    </SectionCard>
  );
}

export function AuditPanel({ site }: { site: string }) {
  const state = useManagePanel<AuditData>(site, "audit");

  return (
    <PanelState state={state}>
      {(data) => {
        const a11yFindings = data.findings.filter((f) => f.category === "a11y");
        const seoFindings = data.findings.filter((f) => f.category === "seo");
        const altMissing = data.status?.alt.missing ?? data.imagesMissingAlt;
        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <SectionCard
              className="lg:col-span-2"
              title="SEO score"
              description={`Engine: ${data.engineName}. Blended on-page SEO and accessibility, computed from live site data.`}
              icon={CheckCircle2}
            >
              {data.connectorTooOld ? (
                <div className="mb-3 flex items-start gap-2.5 rounded-xl border border-amber-400/30 bg-amber-400/5 p-3 text-sm text-amber-700 dark:text-amber-300">
                  <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <p>This site’s connector is too old for the platform SEO cockpit. Update the connector to unlock the score, audit and fixes. Showing the third-party reading meanwhile.</p>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-6">
                <HealthGauge score={data.score} size={104} label="overall" />
                <div className="grid flex-1 grid-cols-2 gap-3 sm:max-w-sm">
                  <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-center dark:border-zinc-800 dark:bg-zinc-950/40">
                    <p className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{data.a11yScore}</p>
                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">Accessibility</p>
                  </div>
                  <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-center dark:border-zinc-800 dark:bg-zinc-950/40">
                    <p className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{data.seoScore === null ? "—" : data.seoScore}</p>
                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">On-page SEO ({data.engineName})</p>
                  </div>
                </div>
              </div>
            </SectionCard>

            <div className="lg:col-span-2">
              <VisibilityGlance data={data} />
            </div>

            <SectionCard title="Accessibility" description="Image alt-text coverage across the media library." icon={Accessibility}>
              <ul className="space-y-2">
                {a11yFindings.map((finding) => (
                  <FindingRow key={finding.id} finding={finding} />
                ))}
              </ul>
              <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
                {data.imageAttachments.toLocaleString("en-US")} image attachment{data.imageAttachments === 1 ? "" : "s"} in the library.
              </p>
              <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                <TierGate site={site} flag="seo_suite">
                  <SeoAltBackfill site={site} missing={altMissing} />
                </TierGate>
              </div>
            </SectionCard>

            <SectionCard title="On-page SEO" description={`Findings measured by ${data.engineName}.`} icon={Search}>
              {seoFindings.length > 0 ? (
                <ul className="space-y-2">
                  {seoFindings.map((finding) => (
                    <FindingRow key={finding.id} finding={finding} />
                  ))}
                </ul>
              ) : (
                <div className="flex items-start gap-2.5 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3 text-sm text-zinc-700 dark:text-zinc-200">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-500" aria-hidden />
                  <p>
                    {data.engine === null
                      ? "No SEO engine is active. Enable the platform SEO Suite (Ultimate) or Meta Audit (Pro), or activate Yoast, to measure on-page SEO."
                      : `On-page findings are measured by ${data.engineName}. No blocking issues detected.`}
                  </p>
                </div>
              )}
            </SectionCard>

            <SectionCard className="lg:col-span-2" title="Meta audit & one-click fixes" description="Scan every page and fix issues without leaving the console." icon={FileSearch}>
              <TierGate site={site} flag="seo_audit">
                <SeoAuditMap site={site} />
              </TierGate>
            </SectionCard>
          </div>
        );
      }}
    </PanelState>
  );
}
