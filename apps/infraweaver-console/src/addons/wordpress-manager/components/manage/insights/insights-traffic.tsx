"use client";

// First-party traffic module for the Traffic & SEO panel — real views/visitors,
// top content, referrers, channels, devices, countries and on-site searches from
// the site's OWN privacy-first analytics engine over the signed channel. No
// third-party provider, no fabricated numbers: a locked site shows an honest
// teaser (S9), an old connector shows an update prompt, and only bounded
// aggregates ever cross the wire (S1). A small 30-day sparkline gives the trend.

import { useMemo, useState } from "react";
import { BarChart3, Globe, Monitor, MousePointerClick, Search, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { DeltaPill, Sparkline, StatTile } from "../../demo/widgets";
import { STATS_RANGES, type StatPair, type StatsRange, type StatsSummaryResponse } from "../../../lib/manage/insights";
import { compactNumber, deriveInsightsView, privacySignals, roundDelta } from "../../../lib/manage/insights-format";
import { useStatsSummary, useStatsTimeseries } from "../../../lib/manage/use-insights";
import { InsightsErrorState, InsightsLoading, InsightsLocked, InsightsTooOld } from "./insights-states";

const WHAT = "First-party traffic insights";

const RANGE_LABEL: Readonly<Record<StatsRange, string>> = { 1: "Today", 7: "7 days", 30: "30 days" };

function RangeSwitch({ range, onChange }: { range: StatsRange; onChange: (r: StatsRange) => void }) {
  return (
    <div className="inline-flex flex-wrap gap-1" role="group" aria-label="Traffic range">
      {STATS_RANGES.map((r) => {
        const active = r === range;
        return (
          <button
            key={r}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(r)}
            className={cn(
              "rounded-lg border px-2 py-1 text-xs font-medium transition-colors",
              active
                ? "border-sky-500 bg-sky-500 text-white"
                : "border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800",
            )}
          >
            {RANGE_LABEL[r]}
          </button>
        );
      })}
    </div>
  );
}

/** A capped [label,count] list, rendered as a compact ranked bar list. */
function PairList({ title, icon: Icon, pairs, empty }: { title: string; icon: React.ElementType; pairs: readonly StatPair[]; empty: string }) {
  const max = pairs.reduce((m, [, c]) => Math.max(m, c), 0) || 1;
  return (
    <div>
      <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        <Icon className="h-3.5 w-3.5" aria-hidden /> {title}
      </h4>
      {pairs.length === 0 ? (
        <p className="mt-2 text-xs text-zinc-400 dark:text-zinc-500">{empty}</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {pairs.map(([label, count], i) => (
            <li key={`${label}-${i}`}>
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate text-zinc-700 dark:text-zinc-300" title={label}>
                  {label || "—"}
                </span>
                <span className="shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">{compactNumber(count)}</span>
              </div>
              <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div className="h-full rounded-full bg-sky-500/70" style={{ width: `${(count / max) * 100}%` }} aria-hidden />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PrivacyFooter({ privacy }: { privacy: StatsSummaryResponse["privacy"] }) {
  const signals = privacySignals(privacy);
  return (
    <p className="mt-4 text-xs text-zinc-500 dark:text-zinc-400">
      First-party, cookieless — no IPs are stored.
      {signals.length > 0 ? ` Respecting: ${signals.join(", ")}.` : ""}
    </p>
  );
}

function TrafficReady({ site, range, summary }: { site: string; range: StatsRange; summary: StatsSummaryResponse }) {
  // The trend sparkline rides the separate timeseries method so the KPI path stays
  // light; a locked/too-old timeseries just hides the spark (the KPIs still show).
  const series = useStatsTimeseries(site, 30);
  const spark = useMemo<number[]>(() => {
    if (!series.data || series.data.locked || !series.data.series) return [];
    return series.data.series.map((p) => p.views);
  }, [series.data]);

  const kpi = summary.kpi;
  const viewsDelta = roundDelta(kpi?.views_delta_pct);
  const visitsDelta = roundDelta(kpi?.visits_delta_pct);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile
          label={`Views · ${RANGE_LABEL[range]}`}
          value={kpi?.views ?? 0}
          icon={BarChart3}
          delta={viewsDelta ?? undefined}
          spark={spark.length > 1 ? spark : undefined}
        />
        <StatTile
          label={`Visitors · ${RANGE_LABEL[range]}`}
          value={kpi?.visits ?? 0}
          icon={TrendingUp}
          delta={visitsDelta ?? undefined}
        />
        <StatTile label="Online now" value={kpi?.online_now ?? 0} icon={MousePointerClick} />
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-sm dark:border-zinc-800 dark:bg-zinc-950/40">
        <span className="text-zinc-600 dark:text-zinc-400">
          Bounce <span className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{summary.quality?.bounce_pct ?? 0}%</span>
        </span>
        <span className="text-zinc-600 dark:text-zinc-400">
          Pages/visit{" "}
          <span className="font-medium tabular-nums text-zinc-900 dark:text-zinc-100">{summary.quality?.pages_per_visit ?? 0}</span>
        </span>
        {viewsDelta !== null ? (
          <span className="inline-flex items-center gap-1 text-zinc-600 dark:text-zinc-400">
            vs previous <DeltaPill value={viewsDelta} />
          </span>
        ) : null}
        {spark.length > 1 ? (
          <span className="ml-auto inline-flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            30-day views <Sparkline data={spark} width={110} height={26} />
          </span>
        ) : null}
      </div>

      <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
        <PairList title="Top pages" icon={BarChart3} pairs={summary.top_pages ?? []} empty="No page views in this window." />
        <PairList title="Referrers" icon={Globe} pairs={summary.top_referrers ?? []} empty="No referrers yet." />
        <PairList title="Channels" icon={MousePointerClick} pairs={summary.channels ?? []} empty="No channel data yet." />
        <PairList title="Devices" icon={Monitor} pairs={summary.devices ?? []} empty="No device data yet." />
        <PairList title="Countries" icon={Globe} pairs={summary.countries ?? []} empty="No country data yet." />
        <PairList title="On-site searches" icon={Search} pairs={summary.searches ?? []} empty="No searches recorded." />
      </div>

      <PrivacyFooter privacy={summary.privacy} />
    </div>
  );
}

/** The traffic module — self-fetching. Owns the range switch; degrades honestly. */
export function InsightsTraffic({ site }: { site: string }) {
  const [range, setRange] = useState<StatsRange>(7);
  const query = useStatsSummary(site, range);
  const view = deriveInsightsView<StatsSummaryResponse>({
    isLoading: query.isLoading,
    data: query.data,
    error: query.error,
  });

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Traffic</h3>
        {view.kind === "ready" ? <RangeSwitch range={range} onChange={setRange} /> : null}
      </div>
      {view.kind === "loading" ? <InsightsLoading rows={4} /> : null}
      {view.kind === "too-old" ? <InsightsTooOld what={WHAT} /> : null}
      {view.kind === "error" ? <InsightsErrorState message={view.message} /> : null}
      {view.kind === "locked" ? (
        <InsightsLocked reason={view.reason} upsell={view.upsell} tier={view.tier} what={WHAT} />
      ) : null}
      {view.kind === "ready" ? <TrafficReady site={site} range={range} summary={view.data} /> : null}
    </div>
  );
}
