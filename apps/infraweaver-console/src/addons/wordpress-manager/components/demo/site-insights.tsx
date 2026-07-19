"use client";

import { Activity, Database, Gauge, Info, Link2, Rocket, ServerCrash, ShieldAlert, Timer, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FleetSiteRow } from "../../lib/fleet/types";
import { useFleet } from "./use-fleet";
import { HealthGauge, STATUS_LABEL, STATUS_TONE, healthTone } from "./widgets";

/** Sections with no secure per-site source yet — shown honestly, never faked. */
const PENDING_INTEGRATIONS: ReadonlyArray<{ title: string; needs: string; icon: React.ElementType }> = [
  { title: "Traffic & visitors", needs: "an analytics integration", icon: Users },
  { title: "Firewall activity", needs: "a WAF / edge-security integration", icon: ShieldAlert },
  { title: "Vulnerability advisories", needs: "a vulnerability-scan integration", icon: ShieldAlert },
  { title: "Backups", needs: "a backup integration", icon: Database },
  { title: "PageSpeed & Core Web Vitals", needs: "a Lighthouse / PageSpeed integration", icon: Gauge },
  { title: "Latency & error history", needs: "Prometheus (see the fleet Monitoring tab)", icon: Activity },
];

function pendingOf(row: FleetSiteRow): number {
  return row.updates.core + row.updates.plugins + row.updates.themes;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "never checked";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "never checked" : d.toLocaleString();
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40">
      <p className="text-xs text-zinc-600 dark:text-zinc-400">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{value}</p>
    </div>
  );
}

function InsightsShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
      <div className="flex items-center gap-2 text-zinc-900 dark:text-zinc-100">
        <Rocket className="h-5 w-5 text-sky-500" aria-hidden />
        <h2 className="text-lg font-medium">Site insights</h2>
      </div>
      {children}
    </section>
  );
}

export function SiteDemoInsights({ site }: { site: string }) {
  const { data, loading, error } = useFleet();

  if (error && !data) {
    return (
      <InsightsShell>
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2.5 text-sm text-red-700 dark:text-red-300">
          <ServerCrash className="h-4 w-4 shrink-0" aria-hidden /> {error}
        </div>
      </InsightsShell>
    );
  }

  if (!data) {
    return (
      <InsightsShell>
        <div className="mt-4 h-40 animate-pulse rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/40" aria-busy={loading} />
      </InsightsShell>
    );
  }

  const row = data.sites.find((s) => s.id === site || s.name === site);

  if (!row) {
    return (
      <InsightsShell>
        <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-400">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden />
          <p>
            No live insights for this site yet. It isn&apos;t reporting through a signed InfraWeaver Connector link, so
            per-site health, round-trip and updates can&apos;t be read securely.
          </p>
        </div>
      </InsightsShell>
    );
  }

  const tone = STATUS_TONE[row.status];
  const pending = pendingOf(row);

  return (
    <InsightsShell>
      <div className="mt-1 flex justify-end">
        <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium", tone.ring, tone.soft, tone.text)}>
          {STATUS_LABEL[row.status]}
        </span>
      </div>

      {/* At-a-glance — every value below is a real, signed signal */}
      <div className="mt-4 grid gap-4 md:grid-cols-[auto_1fr]">
        <div className="flex items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
          {row.health !== null ? (
            <HealthGauge score={row.health} size={112} strokeWidth={10} label="health" />
          ) : (
            <div className="flex h-28 w-28 flex-col items-center justify-center text-center">
              <span className="grid h-16 w-16 place-items-center rounded-full border border-dashed border-zinc-300 text-lg text-zinc-400 dark:border-zinc-700">—</span>
              <span className="mt-2 text-[10px] font-medium text-zinc-500 dark:text-zinc-400">health unreadable</span>
            </div>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Fact label="Round-trip" value={row.responseMs !== null ? `${row.responseMs} ms` : "—"} />
          <Fact label="Updates pending" value={String(pending)} />
          <Fact label="Connector" value={row.connectorVersion ? `v${row.connectorVersion}` : "—"} />
          <Fact label="Link state" value={row.connectorState ?? "not enrolled"} />
        </div>
      </div>

      {/* Real environment + last-check details */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="PHP" value={row.php ?? "—"} />
        <Fact label="WordPress" value={row.wp ?? "—"} />
        <Fact label="Last health check" value={formatWhen(row.lastHealthAt)} />
        <Fact label="Verify rejections" value={String(row.rejections)} />
      </div>

      {row.offline ? (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2.5 text-sm text-red-700 dark:text-red-300">
          <ServerCrash className="h-4 w-4 shrink-0" aria-hidden /> This site&apos;s pod is not ready — signals may be
          stale until it recovers.
        </div>
      ) : (
        <div className="mt-4 flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <Timer className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className={cn("font-medium", healthTone(row.health ?? 0).text)}>
            {row.lastHealthOk === false ? "Last health check failed" : "Reporting through a signed link"}
          </span>
        </div>
      )}

      {/* Honest "needs an integration" cards — no fabricated charts */}
      <div className="mt-6">
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
          <Link2 className="h-4 w-4 text-zinc-400 dark:text-zinc-500" aria-hidden /> Extended insights
        </div>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          These sections light up once the matching data source is connected — nothing here is estimated.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {PENDING_INTEGRATIONS.map((item) => {
            const Icon = item.icon;
            return (
              <div
                key={item.title}
                className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-950/40"
              >
                <div className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  <Icon className="h-4 w-4 text-zinc-400 dark:text-zinc-500" aria-hidden />
                  {item.title}
                </div>
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Needs {item.needs}.</p>
              </div>
            );
          })}
        </div>
      </div>
    </InsightsShell>
  );
}
