"use client";

// Traffic & SEO panel — on-page SEO coverage computed live from wp-cli, plus an
// honest analytics posture. There is no fabricated visitor traffic: live figures
// require an external analytics provider's API the read-only channel can't reach.
// Read-only: no allow-listed mutation exists, so there are no actions.

import type { ReactNode } from "react";
import { BarChart3, FileText, Hash, Info, Map as MapIcon, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AudienceData } from "../../../lib/manage/probes/audience";
import { HealthGauge, SectionCard } from "../widgets";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";

const TILE = "rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40";

type PillTone = "good" | "warn" | "neutral";
const PILL_TONE: Readonly<Record<PillTone, string>> = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
};
function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", PILL_TONE[tone])}>
      {children}
    </span>
  );
}

function pct(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

export function AudiencePanel({ site }: { site: string }) {
  const state = useManagePanel<AudienceData>(site, "audience");

  return (
    <PanelState state={state}>
      {(data) => {
        const { seo, analytics } = data;
        const coverageScore =
          seo.metadescCoverage !== null && seo.focusKwCoverage !== null
            ? Math.round((seo.metadescCoverage + seo.focusKwCoverage) / 2)
            : null;
        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <SectionCard
              title="SEO coverage"
              description={seo.plugin ? `On-page coverage via ${seo.plugin}.` : "No SEO plugin detected."}
              icon={Search}
            >
              {seo.yoast && coverageScore !== null ? (
                <div className="flex items-center gap-4">
                  <HealthGauge score={coverageScore} size={92} strokeWidth={8} label="coverage" />
                  <dl className="min-w-0 flex-1 space-y-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <dt className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
                        <FileText className="h-3.5 w-3.5" aria-hidden /> Indexable posts
                      </dt>
                      <dd className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
                        {seo.publishedPosts.toLocaleString("en-US")}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-zinc-600 dark:text-zinc-400">Meta description</dt>
                      <dd className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{pct(seo.metadescCoverage)}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
                        <Hash className="h-3.5 w-3.5" aria-hidden /> Focus keyphrase
                      </dt>
                      <dd className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{pct(seo.focusKwCoverage)}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="flex items-center gap-1.5 text-zinc-600 dark:text-zinc-400">
                        <MapIcon className="h-3.5 w-3.5" aria-hidden /> XML sitemap
                      </dt>
                      <dd>
                        {seo.sitemapEnabled === null ? (
                          <Pill tone="neutral">Unknown</Pill>
                        ) : seo.sitemapEnabled ? (
                          <Pill tone="good">Enabled</Pill>
                        ) : (
                          <Pill tone="warn">Disabled</Pill>
                        )}
                      </dd>
                    </div>
                  </dl>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className={cn("flex items-center justify-between gap-3", TILE)}>
                    <span className="text-sm text-zinc-600 dark:text-zinc-400">Indexable posts</span>
                    <span className="text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                      {seo.publishedPosts.toLocaleString("en-US")}
                    </span>
                  </div>
                  <div className="flex items-start gap-2.5 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3 text-sm text-zinc-700 dark:text-zinc-200">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-500" aria-hidden />
                    <p>
                      Detailed on-page coverage (meta description, focus keyphrase, sitemap) is computed from Yoast SEO
                      metadata. {seo.plugin ? `${seo.plugin} is active, but its data model differs` : "No SEO plugin is active"} — connect
                      Yoast to surface these metrics.
                    </p>
                  </div>
                </div>
              )}
            </SectionCard>

            <SectionCard
              title="Analytics"
              description="Live traffic comes from your analytics provider."
              icon={BarChart3}
            >
              <div className={cn("flex items-center justify-between gap-3", TILE)}>
                <span className="text-sm text-zinc-600 dark:text-zinc-400">Detected plugin</span>
                {analytics.plugin ? (
                  <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{analytics.plugin}</span>
                ) : (
                  <Pill tone="neutral">None active</Pill>
                )}
              </div>
              <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3 text-sm text-zinc-700 dark:text-zinc-200">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-500" aria-hidden />
                <p>
                  {analytics.plugin
                    ? `${analytics.plugin} is active on this site. Live visitor figures require connecting that provider's API — they aren't available over the read-only management channel, so no traffic numbers are shown here.`
                    : "Activate an analytics plugin (Site Kit, Matomo, …) and connect its provider to report visitor traffic. The read-only management channel can't measure live visits on its own."}
                </p>
              </div>
            </SectionCard>
          </div>
        );
      }}
    </PanelState>
  );
}
