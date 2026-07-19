"use client";

// Traffic & SEO — audience-facing metrics for the per-site "Manage" console (demo).
import type { ReactNode } from "react";
import { FileText, Hash, Search, TrendingUp, Unlink } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { SiteManageData } from "../site-manage-data";
import { AnimatedNumber, DeltaPill, HealthGauge, SectionCard } from "../widgets";
import { TrafficArea } from "../charts";
import { DummyBadge } from "../DummyBadge";

const TILE = "rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40";
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
const DEMO_MSG = "Demo — no changes are made to the live site.";

type PillTone = "good" | "warn" | "critical" | "neutral";
const PILL_TONE: Readonly<Record<PillTone, string>> = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  critical: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  neutral: "border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-300",
};
function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", PILL_TONE[tone])}>
      {children}
    </span>
  );
}

function codeBadge(code: number): { tone: PillTone; label: string } {
  if (code === 0) return { tone: "critical", label: "timeout" };
  if (code === 301) return { tone: "warn", label: "301" };
  return { tone: "critical", label: String(code) };
}

export function AudiencePanel({ data }: { data: SiteManageData; site: string }) {
  const totalVisitors = data.trafficTrend.reduce((sum, day) => sum + day.visitors, 0);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <SectionCard title="Traffic" description="Weekly visitor volume." icon={TrendingUp} action={<DummyBadge />} className="lg:col-span-2">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium text-zinc-600 dark:text-zinc-400">Visitors this week</span>
          <AnimatedNumber value={totalVisitors} className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100" />
        </div>
        <TrafficArea data={data.trafficTrend} />
      </SectionCard>

      <SectionCard title="Top pages" description="Most-viewed URLs this week." icon={FileText} action={<DummyBadge />}>
        <ol className="space-y-2">
          {data.topPages.map((page, i) => (
            <li key={page.path} className={cn(TILE, "flex items-center gap-3")}>
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-zinc-200 text-[11px] font-semibold tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-700 dark:text-zinc-300">{page.path}</span>
              <span className="shrink-0 text-sm font-medium tabular-nums text-zinc-900 dark:text-zinc-100">
                {page.views.toLocaleString("en-US")}
              </span>
            </li>
          ))}
        </ol>
      </SectionCard>

      <SectionCard title="SEO health" description="Search visibility snapshot." icon={Search} action={<DummyBadge />}>
        <div className="flex items-center gap-4">
          <HealthGauge score={data.seo.score} size={92} strokeWidth={8} label="SEO score" />
          <dl className="min-w-0 flex-1 space-y-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <dt className="text-zinc-600 dark:text-zinc-400">Indexed pages</dt>
              <dd className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{data.seo.indexed.toLocaleString("en-US")}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-zinc-600 dark:text-zinc-400">Sitemap</dt>
              <dd>{data.seo.sitemapOk ? <Pill tone="good">Submitted</Pill> : <Pill tone="warn">Missing</Pill>}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-zinc-600 dark:text-zinc-400">Meta coverage</dt>
              <dd className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{data.seo.metaCoverage}%</dd>
            </div>
          </dl>
        </div>
        <div className="mt-4 flex justify-end">
          <button type="button" className={BTN} onClick={() => toast.info(DEMO_MSG)}>
            <Search className="h-4 w-4" aria-hidden /> Re-crawl
          </button>
        </div>
      </SectionCard>

      <SectionCard title="Keyword rankings" description="Organic positions and monthly search volume." icon={Hash} action={<DummyBadge />}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="py-2 font-medium">Term</th>
                <th className="py-2 font-medium">Position</th>
                <th className="py-2 font-medium">Change</th>
                <th className="py-2 text-right font-medium">Volume</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {data.keywords.map((k, i) => (
                <tr key={`${k.term}-${i}`}>
                  <td className="py-2 pr-2 text-zinc-900 dark:text-zinc-100">{k.term}</td>
                  <td className="py-2 pr-2 tabular-nums text-zinc-700 dark:text-zinc-300">#{k.position}</td>
                  <td className="py-2 pr-2">
                    <DeltaPill value={k.delta} positiveIsGood={false} />
                  </td>
                  <td className="py-2 text-right tabular-nums text-zinc-700 dark:text-zinc-300">{k.volume.toLocaleString("en-US")}/mo</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="Broken links" description="Dead links found in the latest crawl." icon={Unlink} action={<DummyBadge />} className="lg:col-span-2">
        {data.brokenLinks.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            No broken links found in the last crawl.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500">
                  <th className="py-2 font-medium">URL</th>
                  <th className="py-2 font-medium">Found on</th>
                  <th className="py-2 font-medium">Code</th>
                  <th className="py-2 text-right font-medium">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {data.brokenLinks.map((link, i) => {
                  const badge = codeBadge(link.code);
                  return (
                    <tr key={`${link.url}-${i}`}>
                      <td className="min-w-0 py-2 pr-3">
                        <span className="block max-w-[240px] truncate font-mono text-[11px] text-zinc-700 dark:text-zinc-300">{link.url}</span>
                      </td>
                      <td className="py-2 pr-3 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{link.foundOn}</td>
                      <td className="py-2 pr-3">
                        <Pill tone={badge.tone}>{badge.label}</Pill>
                      </td>
                      <td className="py-2 text-right text-zinc-500 dark:text-zinc-400">{link.when}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <button type="button" className={BTN} onClick={() => toast.info(DEMO_MSG)}>
            <Unlink className="h-4 w-4" aria-hidden /> Re-scan links
          </button>
        </div>
      </SectionCard>
    </div>
  );
}
