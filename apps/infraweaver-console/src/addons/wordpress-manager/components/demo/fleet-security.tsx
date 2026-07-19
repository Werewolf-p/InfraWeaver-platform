"use client";

import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowUpCircle,
  Bug,
  CheckCircle2,
  Puzzle,
  RefreshCw,
  ScanSearch,
  ServerCrash,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { FleetSecuritySiteRow } from "../../lib/fleet/security-agg";
import { riseItem, staggerContainer } from "./motion";
import { useFleetSecurity } from "./use-fleet-security";
import { SectionCard, StatTile, STATUS_TONE, healthTone, type Tone } from "./widgets";

const SKELETON_TILES: readonly number[] = [0, 1, 2, 3];

/** 0 concerns → healthy tone; any concern → the given "bad" tone. No invented numbers. */
function countTone(count: number, bad: Tone): Tone {
  return count === 0 ? STATUS_TONE.healthy : bad;
}

function SecuritySkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {SKELETON_TILES.map((i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/40"
          />
        ))}
      </div>
      <div className="h-64 animate-pulse rounded-2xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/40" />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="h-56 animate-pulse rounded-2xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/40" />
        <div className="h-56 animate-pulse rounded-2xl border border-zinc-200 bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-800/40" />
      </div>
    </div>
  );
}

function SecurityErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-6 text-center">
      <ServerCrash className="mx-auto h-6 w-6 text-red-500" aria-hidden />
      <p className="mt-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">Couldn&apos;t load fleet security</p>
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Retry
      </button>
    </div>
  );
}

/**
 * Honest empty-state for a feed with no wired integration. Renders the real
 * `reason` from the server — never a fabricated CVE list or WAF chart.
 */
function DegradedFeed({ reason }: { reason: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-4 py-10 text-center dark:border-zinc-700 dark:bg-zinc-950/40">
      <span className="grid h-9 w-9 place-items-center rounded-lg border border-zinc-200 bg-white text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900">
        <ScanSearch className="h-4 w-4" aria-hidden />
      </span>
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Not configured</p>
      <p className="max-w-sm text-xs text-zinc-500 dark:text-zinc-400">{reason}</p>
    </div>
  );
}

/** Real, per-site security concerns — derived only from live fleet signals. */
function siteConcerns(row: FleetSecuritySiteRow): { label: string; tone: "bad" | "warn" }[] {
  const out: { label: string; tone: "bad" | "warn" }[] = [];
  if (row.offline) out.push({ label: "offline", tone: "bad" });
  if (row.connectorState === "quarantined") out.push({ label: "connector quarantined", tone: "bad" });
  if (row.rejections > 0) {
    out.push({ label: `${row.rejections} rejection${row.rejections === 1 ? "" : "s"}`, tone: "bad" });
  }
  if (row.coreUpdate) out.push({ label: "core update pending", tone: "warn" });
  if (row.pluginUpdates > 0) {
    out.push({ label: `${row.pluginUpdates} plugin update${row.pluginUpdates === 1 ? "" : "s"}`, tone: "warn" });
  }
  return out;
}

const CONCERN_TONE: Readonly<Record<"bad" | "warn", string>> = {
  bad: "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

function SiteSecurityRow({ row }: { row: FleetSecuritySiteRow }) {
  const concerns = siteConcerns(row);
  const tone = healthTone(row.health ?? 0);
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-950/40">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{row.site}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {concerns.length === 0 ? (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> No pending security actions
            </span>
          ) : (
            concerns.map((c) => (
              <span
                key={c.label}
                className={cn(
                  "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
                  CONCERN_TONE[c.tone],
                )}
              >
                {c.label}
              </span>
            ))
          )}
        </div>
      </div>
      <span
        className={cn(
          "shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums",
          tone.ring,
          tone.soft,
          tone.text,
        )}
      >
        {row.health !== null ? `Health ${row.health}` : "Health —"}
      </span>
    </li>
  );
}

export function FleetSecurity() {
  const { data, loading, error, reload } = useFleetSecurity();

  if (error && !data) {
    return <SecurityErrorCard message={error} onRetry={reload} />;
  }
  if (!data) {
    // Covers `loading && !data` (and the null-before-first-load case).
    return <SecuritySkeleton />;
  }

  const { posture, vulnerabilities, waf, generatedAt } = data;
  const cleanSites = posture.rows.filter((r) => siteConcerns(r).length === 0).length;

  return (
    <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-6">
      {/* Last-checked + refresh (real generatedAt from the hook) */}
      <motion.div
        variants={riseItem}
        className="flex items-center justify-end gap-2 text-xs text-zinc-500 dark:text-zinc-400"
      >
        <span>Last checked {new Date(generatedAt).toLocaleTimeString()}</span>
        <button
          type="button"
          onClick={reload}
          className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-1 font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} aria-hidden /> Refresh
        </button>
      </motion.div>

      {/* Real posture tiles — counts across the whole fleet, no fabricated numbers */}
      <motion.div variants={riseItem} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Core updates pending"
          value={posture.coreUpdatesPending}
          suffix={`/${posture.totalSites}`}
          icon={ArrowUpCircle}
          tone={countTone(posture.coreUpdatesPending, STATUS_TONE.attention)}
        />
        <StatTile
          label="Plugin updates pending"
          value={posture.pluginUpdatesPending}
          suffix={`/${posture.totalSites}`}
          icon={Puzzle}
          tone={countTone(posture.pluginUpdatesPending, STATUS_TONE.attention)}
        />
        <StatTile
          label="Quarantined / rejecting"
          value={posture.quarantined}
          icon={ShieldAlert}
          tone={countTone(posture.quarantined, STATUS_TONE.critical)}
        />
        <StatTile
          label="Offline sites"
          value={posture.offline}
          icon={ServerCrash}
          tone={countTone(posture.offline, STATUS_TONE.critical)}
        />
      </motion.div>

      {/* Per-site security posture — real signals per managed site */}
      <motion.div variants={riseItem}>
        <SectionCard
          title="Per-site security posture"
          description="Pending updates, signed-link state and health for every managed site — from live signals."
          icon={ShieldCheck}
        >
          {posture.rows.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">No managed sites yet.</p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> {cleanSites} clear
                </span>
                <span className="inline-flex items-center gap-1">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-hidden />
                  {posture.rows.length - cleanSites} need attention
                </span>
                {posture.rejectionsTotal > 0 ? (
                  <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
                    <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> {posture.rejectionsTotal} signed-command
                    rejection{posture.rejectionsTotal === 1 ? "" : "s"}
                  </span>
                ) : null}
              </div>
              <ul className="space-y-2">
                {posture.rows.map((row) => (
                  <SiteSecurityRow key={row.site} row={row} />
                ))}
              </ul>
            </>
          )}
        </SectionCard>
      </motion.div>

      {/* Vulnerability + WAF feeds — degrade honestly when no integration is wired */}
      <div className="grid gap-6 lg:grid-cols-2">
        <motion.div variants={riseItem}>
          <SectionCard
            title="Vulnerability feed"
            description="Component-level CVEs across the fleet."
            icon={Bug}
          >
            {vulnerabilities.configured ? (
              // Only reached once a real CVE feed is wired; until then we never
              // fabricate advisories — the honest empty-state below is shown.
              <p className="text-sm text-zinc-600 dark:text-zinc-400">
                {vulnerabilities.items.length} open advisor
                {vulnerabilities.items.length === 1 ? "y" : "ies"}.
              </p>
            ) : (
              <DegradedFeed
                reason={vulnerabilities.reason ?? "Vulnerability feed not configured."}
              />
            )}
          </SectionCard>
        </motion.div>

        <motion.div variants={riseItem}>
          <SectionCard
            title="Firewall (WAF) activity"
            description="Malicious requests blocked at the edge."
            icon={ShieldAlert}
          >
            {waf.configured ? (
              // Never reached until a security plugin exposes WAF data over the signed
              // channel — kept so the empty/real split stays explicit.
              <p className="text-sm text-zinc-600 dark:text-zinc-400">WAF metrics available.</p>
            ) : (
              <DegradedFeed reason={waf.reason ?? "WAF metrics not configured."} />
            )}
          </SectionCard>
        </motion.div>
      </div>
    </motion.div>
  );
}
