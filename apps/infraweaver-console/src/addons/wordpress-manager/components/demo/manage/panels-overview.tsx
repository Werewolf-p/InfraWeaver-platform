"use client";

/**
 * Overview landing — the Manage console's home section, redesigned as a control
 * center rather than a wall of identical tiles:
 *
 *  1. an "Attention" triage feed — the 1-3 things that actually need the owner,
 *     derived from real overview signals (pending updates, EOL PHP, missing page
 *     cache), each with a one-click jump to where it's fixed. Empty ⇒ a calm
 *     "all clear". This answers "what needs me?" before the owner has to hunt.
 *  2. the health hero + honest status cards. Every card tone is now COMPUTED FROM
 *     DATA — the old landing hardcoded green/blue tones (Database always sky,
 *     Media always green, Security literally the word "Review" in calm blue) which
 *     trained a non-technical owner to ignore a dashboard that was reassuring by
 *     default. Facts that carry no good/bad meaning (a database size, an uploads
 *     size) render neutral; only real thresholds colour a card.
 *
 * Every card still DEEP-LINKS into its section via the rail's `onNavigate`.
 */

import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Cpu,
  Database,
  Gauge,
  HeartPulse,
  Image as ImageIcon,
  Plug,
  Puzzle,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ManageOverview } from "../../../lib/manage/types";
import { HealthGauge, type Tone } from "../widgets";
import type { ManageRailTarget, ManageSectionId } from "./section-groups";

/** Honest, self-contained tones for the landing (no fabricated "everything's fine"). */
const TONE_NEUTRAL: Tone = {
  stroke: "#a1a1aa",
  text: "text-zinc-500 dark:text-zinc-400",
  soft: "bg-zinc-500/10",
  ring: "border-zinc-500/30",
};
const TONE_GOOD: Tone = {
  stroke: "#10b981",
  text: "text-emerald-600 dark:text-emerald-400",
  soft: "bg-emerald-500/10",
  ring: "border-emerald-500/30",
};
const TONE_WARN: Tone = {
  stroke: "#f59e0b",
  text: "text-amber-600 dark:text-amber-400",
  soft: "bg-amber-500/10",
  ring: "border-amber-500/30",
};
const TONE_CRIT: Tone = {
  stroke: "#ef4444",
  text: "text-red-600 dark:text-red-400",
  soft: "bg-red-500/10",
  ring: "border-red-500/30",
};

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
  // Default to NEUTRAL (not brand-sky) so "no meaningful tone" never reads as a
  // reassuring blue — the honesty fix that motivated this redesign.
  const iconTone = tone ?? TONE_NEUTRAL;
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs font-medium text-zinc-600 dark:text-zinc-400">
          <span className={cn("grid h-6 w-6 place-items-center rounded-md", iconTone.soft, iconTone.text)}>
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

/** One triage item on the attention feed. */
type Severity = "critical" | "warn";
interface AttentionItem {
  readonly key: string;
  readonly severity: Severity;
  readonly title: string;
  readonly detail: string;
  readonly target?: ManageSectionId;
  readonly cta: string;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warn: 1 };

/** The parsed PHP major version, or null when unknown/unparseable. */
function phpMajor(phpVersion: string | null): number | null {
  if (!phpVersion) return null;
  const n = Number(phpVersion.split(".")[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Derive the "what needs me" feed from overview signals only — no extra fetch. A
 * richer, alerts-probe-backed feed is the Phase-3 follow-up; this already turns the
 * landing from "counts you must interpret" into "here's what to do".
 */
function computeAttention(overview: ManageOverview): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (overview.pendingUpdates > 0) {
    const breakdown = [
      overview.coreUpdate ? "WordPress core" : null,
      overview.pluginUpdates > 0 ? `${overview.pluginUpdates} plugin${overview.pluginUpdates === 1 ? "" : "s"}` : null,
      overview.themeUpdates > 0 ? `${overview.themeUpdates} theme${overview.themeUpdates === 1 ? "" : "s"}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    items.push({
      key: "updates",
      severity: overview.coreUpdate || overview.pendingUpdates >= 4 ? "critical" : "warn",
      title: `${overview.pendingUpdates} update${overview.pendingUpdates === 1 ? "" : "s"} available`,
      detail: breakdown || "Keep the site current to stay secure.",
      target: "updates",
      cta: "Review updates",
    });
  }

  const major = phpMajor(overview.phpVersion);
  if (major !== null && major < 8) {
    items.push({
      key: "php",
      severity: "critical",
      title: `PHP ${overview.phpVersion} is end-of-life`,
      detail: "An unsupported PHP version stops getting security fixes — ask your host to move to PHP 8+.",
      target: "health",
      cta: "See health",
    });
  }

  if (!overview.cachePlugin) {
    items.push({
      key: "cache",
      severity: "warn",
      title: "No page cache detected",
      detail: "Pages are rebuilt on every visit. A cache plugin makes the site noticeably faster.",
      target: "performance",
      cta: "Improve speed",
    });
  }

  // SEO triage joins the same feed (A2) — the worst 1–2 fixes from the engine-aware
  // `seo.status` snapshot, so SEO is triaged with everything else, not siloed. A
  // zero-issue / unmeasured site contributes nothing (no noise).
  if (overview.seo?.measured) {
    for (const fix of overview.seo.topFixes.slice(0, 2)) {
      items.push({
        key: `seo-${fix.key}`,
        severity: fix.severity === "critical" ? "critical" : "warn",
        title: fix.label,
        detail: "Open the SEO cockpit to review and fix it.",
        target: "audit",
        cta: "Fix SEO",
      });
    }
  }

  return items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

function AttentionFeed({
  overview,
  visibleSections,
  onNavigate,
}: {
  overview: ManageOverview;
  visibleSections: ReadonlySet<ManageSectionId>;
  onNavigate: (target: ManageRailTarget) => void;
}) {
  const items = computeAttention(overview);

  if (items.length === 0) {
    return (
      <div
        role="status"
        className="mb-4 flex items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.06] px-4 py-3.5 text-sm dark:border-emerald-400/30"
      >
        <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
        <div>
          <p className="font-medium text-emerald-800 dark:text-emerald-200">All clear</p>
          <p className="text-emerald-700/90 dark:text-emerald-300/80">Nothing needs your attention right now.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-2xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden />
        <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Needs your attention</h3>
        <span className="ml-auto rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium tabular-nums text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
          {items.length}
        </span>
      </div>
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/80">
        {items.map((item) => {
          const tone = item.severity === "critical" ? TONE_CRIT : TONE_WARN;
          const canJump = item.target !== undefined && visibleSections.has(item.target);
          return (
            <li key={item.key} className="flex items-start gap-3 px-4 py-3">
              <span className={cn("mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md", tone.soft, tone.text)}>
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{item.title}</p>
                <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">{item.detail}</p>
              </div>
              {canJump ? (
                <button
                  type="button"
                  onClick={() => onNavigate(item.target as ManageRailTarget)}
                  className="shrink-0 self-center rounded-md border border-zinc-200 px-2.5 py-1 text-xs font-medium text-zinc-700 transition-colors hover:border-sky-500/40 hover:text-sky-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:text-sky-400"
                >
                  {item.cta}
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
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
  const updateTone = pending === 0 ? TONE_GOOD : pending >= 4 || overview.coreUpdate ? TONE_CRIT : TONE_WARN;
  const connector = overview.connector;

  const updateBreakdown = [
    overview.coreUpdate ? "core" : null,
    overview.pluginUpdates > 0 ? `${overview.pluginUpdates} plugin${overview.pluginUpdates === 1 ? "" : "s"}` : null,
    overview.themeUpdates > 0 ? `${overview.themeUpdates} theme${overview.themeUpdates === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div>
      <AttentionFeed overview={overview} visibleSections={visibleSections} onNavigate={onNavigate} />

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

        {/* Status grid — honest tones only. */}
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
          {/* Database & Media are facts, not verdicts → neutral (no fabricated tone). */}
          <StatusCard
            icon={Database}
            label="Database"
            value={mbLabel(overview.dbSizeMb)}
            sub="Tables, autoload & overhead"
            target="data"
            navigable={has("data")}
            onNavigate={onNavigate}
          />
          <StatusCard
            icon={ImageIcon}
            label="Media"
            value={mbLabel(overview.uploadsMb)}
            sub="Uploads library"
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
                : "Optional — enable for signed liveness"
            }
            tone={connector.active ? TONE_GOOD : TONE_NEUTRAL}
            target={connector.active ? "uptime" : undefined}
            navigable={connector.active && has("uptime")}
            onNavigate={onNavigate}
          />
          {/* Security shows a neutral "Review" prompt — never a fabricated calm-blue
              score. Wiring the real posture score is the Phase-3 follow-up. */}
          <StatusCard
            icon={ShieldCheck}
            label="Security"
            value="Review"
            sub="Integrity, SSL & admin exposure"
            target="security"
            navigable={has("security")}
            onNavigate={onNavigate}
          />
          {/* Cache: "Off" is a real speed gap → warn, not a soothing blue. */}
          <StatusCard
            icon={Gauge}
            label="Cache"
            value={overview.cachePlugin ? "On" : "Off"}
            sub={overview.cachePlugin ?? "No cache plugin detected"}
            tone={overview.cachePlugin ? TONE_GOOD : TONE_WARN}
            target="performance"
            navigable={has("performance")}
            onNavigate={onNavigate}
          />
          <StatusCard
            icon={HeartPulse}
            label="WordPress"
            value={overview.wpVersion ?? "—"}
            sub={overview.phpVersion ? `PHP ${overview.phpVersion}` : "Core version"}
            tone={overview.coreUpdate ? TONE_WARN : TONE_GOOD}
            target="health"
            navigable={has("health")}
            onNavigate={onNavigate}
          />
          {/* SEO — an engine-aware score (our SEO Suite / Meta Audit), sourced from the
              signed seo.status snapshot; "Not measured" (neutral) when no engine is
              active, never a fabricated green (A1). */}
          <StatusCard
            icon={Search}
            label="SEO"
            value={overview.seo?.measured ? String(overview.seo.score ?? "—") : "Not measured"}
            sub={
              overview.seo?.measured
                ? overview.seo.engine === "suite"
                  ? "SEO Suite"
                  : overview.seo.engine === "audit"
                    ? "Meta Audit"
                    : "Measured"
                : "Enable an SEO engine to measure"
            }
            tone={
              !overview.seo?.measured
                ? TONE_NEUTRAL
                : overview.seo.rating === "good"
                  ? TONE_GOOD
                  : overview.seo.rating === "critical"
                    ? TONE_CRIT
                    : TONE_WARN
            }
            target="audit"
            navigable={has("audit")}
            onNavigate={onNavigate}
          />
        </div>
      </div>
    </div>
  );
}
