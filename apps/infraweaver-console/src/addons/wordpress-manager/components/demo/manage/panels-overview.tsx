"use client";

/**
 * Overview landing — the Manage console's home section. A status-card grid (site
 * health, updates, extensions, database, media, connector, security, cache) read
 * live from the overview snapshot; every card DEEP-LINKS into its section via the
 * rail's `onNavigate`, so the landing doubles as a launchpad. The health hero is
 * deliberately distinct from the compact status cards so the grid never reads as a
 * row of identical tiles.
 */

import type { ReactNode } from "react";
import {
  ArrowUpRight,
  Cpu,
  Database,
  Gauge,
  HeartPulse,
  Image as ImageIcon,
  Plug,
  Puzzle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ManageOverview } from "../../../lib/manage/types";
import { HealthGauge, healthTone, type Tone } from "../widgets";
import type { ManageRailTarget, ManageSectionId } from "./section-groups";

interface StatusCardProps {
  readonly icon: React.ElementType;
  readonly label: string;
  readonly value: ReactNode;
  readonly sub?: string;
  readonly tone?: Tone;
  readonly target?: ManageRailTarget;
  readonly navigable: boolean;
  readonly onNavigate: (target: ManageRailTarget) => void;
}

function StatusCard({ icon: Icon, label, value, sub, tone, target, navigable, onNavigate }: StatusCardProps) {
  const clickable = navigable && target !== undefined;
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          <span className={cn("grid h-6 w-6 place-items-center rounded-md", tone?.soft ?? "bg-sky-500/10", tone?.text ?? "text-sky-600 dark:text-sky-400")}>
            <Icon className="h-3.5 w-3.5" aria-hidden />
          </span>
          {label}
        </span>
        {clickable ? (
          <ArrowUpRight className="h-4 w-4 text-zinc-400 transition-colors group-hover:text-sky-500 dark:text-zinc-500" aria-hidden />
        ) : null}
      </div>
      <div className="mt-3 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{value}</div>
      {sub ? <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{sub}</p> : null}
    </>
  );

  const base = "rounded-xl border border-zinc-200 bg-white p-4 text-left dark:border-zinc-800 dark:bg-zinc-900/60";
  if (!clickable) {
    return <div className={base}>{body}</div>;
  }
  return (
    <button
      type="button"
      onClick={() => onNavigate(target)}
      className={cn(
        base,
        "group transition-colors hover:border-sky-500/40 hover:bg-sky-500/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 dark:hover:border-sky-400/40",
      )}
    >
      {body}
    </button>
  );
}

function mbLabel(value: number | null): string {
  if (value === null) return "—";
  return `${value.toLocaleString()} MB`;
}

export function OverviewLanding({
  overview,
  visibleSections,
  onNavigate,
}: {
  overview: ManageOverview;
  visibleSections: ReadonlySet<ManageSectionId>;
  onNavigate: (target: ManageRailTarget) => void;
}) {
  const has = (id: ManageSectionId): boolean => visibleSections.has(id);
  const pending = overview.pendingUpdates;
  const updateTone = healthTone(pending === 0 ? 96 : pending < 4 ? 74 : 46);
  const connector = overview.connector;

  const updateBreakdown = [
    overview.coreUpdate ? "core" : null,
    overview.pluginUpdates > 0 ? `${overview.pluginUpdates} plugin${overview.pluginUpdates === 1 ? "" : "s"}` : null,
    overview.themeUpdates > 0 ? `${overview.themeUpdates} theme${overview.themeUpdates === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,15rem)_1fr]">
      {/* Health hero — distinct from the compact status cards. */}
      <button
        type="button"
        onClick={() => (has("health") ? onNavigate("health") : undefined)}
        disabled={!has("health")}
        className={cn(
          "group flex flex-col items-center justify-center gap-3 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/60",
          has("health") &&
            "transition-colors hover:border-sky-500/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 dark:hover:border-sky-400/40",
        )}
      >
        <HealthGauge score={overview.health} size={124} strokeWidth={11} label="site health" />
        <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400">
          <HeartPulse className="h-3.5 w-3.5" aria-hidden />
          {has("health") ? (
            <span className="group-hover:text-sky-600 dark:group-hover:text-sky-400">View Site Health</span>
          ) : (
            <span>Overall status</span>
          )}
        </div>
      </button>

      {/* Status grid. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatusCard
          icon={RefreshCw}
          label="Updates"
          value={pending}
          sub={pending === 0 ? "Everything up to date" : updateBreakdown || `${pending} pending`}
          tone={updateTone}
          target="updates"
          navigable={has("updates")}
          onNavigate={onNavigate}
        />
        <StatusCard
          icon={Puzzle}
          label="Extensions"
          value={`${overview.activePlugins}/${overview.totalPlugins}`}
          sub="active plugins"
          target="inventory"
          navigable={has("inventory")}
          onNavigate={onNavigate}
        />
        <StatusCard
          icon={Database}
          label="Database"
          value={mbLabel(overview.dbSizeMb)}
          sub="Tables, autoload & overhead"
          tone={healthTone(70)}
          target="data"
          navigable={has("data")}
          onNavigate={onNavigate}
        />
        <StatusCard
          icon={ImageIcon}
          label="Media"
          value={mbLabel(overview.uploadsMb)}
          sub="Uploads library"
          tone={healthTone(80)}
          target="media"
          navigable={has("media")}
          onNavigate={onNavigate}
        />
        <StatusCard
          icon={connector.active ? Cpu : Plug}
          label="Connector"
          value={connector.active ? `${connector.lastRoundtripMs ?? 0} ms` : "Not linked"}
          sub={
            connector.active
              ? connector.connectorVersion
                ? `v${connector.connectorVersion} · signed link`
                : "Signed link active"
              : "Enable for signed liveness"
          }
          tone={healthTone(connector.active ? 90 : 0)}
          target={connector.active ? "uptime" : undefined}
          navigable={connector.active && has("uptime")}
          onNavigate={onNavigate}
        />
        <StatusCard
          icon={ShieldCheck}
          label="Security"
          value="Review"
          sub="Integrity, SSL & admin exposure"
          tone={healthTone(85)}
          target="security"
          navigable={has("security")}
          onNavigate={onNavigate}
        />
        <StatusCard
          icon={Gauge}
          label="Cache"
          value={overview.cachePlugin ? "On" : "Off"}
          sub={overview.cachePlugin ?? "No cache plugin detected"}
          tone={healthTone(overview.cachePlugin ? 88 : 60)}
          target="performance"
          navigable={has("performance")}
          onNavigate={onNavigate}
        />
        <StatusCard
          icon={HeartPulse}
          label="WordPress"
          value={overview.wpVersion ?? "—"}
          sub={overview.phpVersion ? `PHP ${overview.phpVersion}` : "Core version"}
          tone={healthTone(overview.coreUpdate ? 55 : 92)}
          target="health"
          navigable={has("health")}
          onNavigate={onNavigate}
        />
      </div>
    </div>
  );
}
