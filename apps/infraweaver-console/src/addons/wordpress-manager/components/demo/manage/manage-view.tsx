"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { ChevronDown, RefreshCw, Wand2, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { EASE_OUT } from "../motion";
import { MANAGE_PANELS, getPanelDef, type ManagePanelId } from "../../../lib/manage/capabilities";
import { PanelError, PanelSkeleton } from "./panel-shell";
import { OptionalDisabledPanel } from "./panel-optional";
import {
  OPTIONAL_SECTION,
  SYNTHETIC_SECTIONS,
  buildVisibleGroups,
  flattenSections,
  isSyntheticSection,
  type ManageRailTarget,
  type ManageSectionId,
} from "./section-groups";
import { SectionNav, SectionNavSkeleton } from "./section-nav";
import { OverviewLanding } from "./panels-overview";
import { SettingsPanel } from "./panels-settings";
import { useManageOverview } from "./use-manage";
import { UpdatesPanel } from "./panels-updates";
import { InventoryPanel } from "./panels-inventory";
import { ContentPanel } from "./panels-content";
import { MediaExplorer } from "../../manage/media/media-explorer";
import { StorePanel } from "./panels-store";
import { FormsPanel } from "./panels-forms";
import { BackupsPanel } from "./panels-backups";
import { StagingPanel } from "./panels-staging";
import { SecurityPanel } from "./panels-security";
import { AuditPanel } from "./panels-audit";
import { PerformancePanel } from "../../manage/performance/performance-panel";
import { ResourcesPanel } from "./panels-resources";
import { UptimePanel } from "./panels-uptime";
import { MetricsPanel } from "./panels-metrics";
import { AudiencePanel } from "./panels-audience";
import { EmailPanel } from "./panels-email";
import { PeoplePanel } from "./panels-people";
import { ClientsPanel } from "./panels-clients";
import { AlertsPanel } from "./panels-alerts";
import { LogsPanel } from "./panels-logs";
import { DatabaseCockpit } from "../../manage/database/database-cockpit";
import { HealthPanel } from "./panels-health";

/** Stable id of the single content region every section button controls. */
const SECTION_PANEL_ID = "manage-section-panel";
const SECTION_TITLE_ID = "manage-section-title";

/** Compact "when the snapshot was gathered" label for the header. */
function formatUpdatedAt(cachedAt?: number): string | null {
  if (!cachedAt) return null;
  const secs = Math.max(0, Math.round((Date.now() - cachedAt) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Map a panel id to its self-fetching component. */
const PANEL_COMPONENTS: Record<ManagePanelId, (props: { site: string }) => React.ReactNode> = {
  updates: UpdatesPanel,
  inventory: InventoryPanel,
  content: ContentPanel,
  media: MediaExplorer,
  store: StorePanel,
  forms: FormsPanel,
  backups: BackupsPanel,
  staging: StagingPanel,
  security: SecurityPanel,
  audit: AuditPanel,
  performance: PerformancePanel,
  resources: ResourcesPanel,
  uptime: UptimePanel,
  metrics: MetricsPanel,
  audience: AudiencePanel,
  email: EmailPanel,
  people: PeoplePanel,
  clients: ClientsPanel,
  alerts: AlertsPanel,
  logs: LogsPanel,
  data: DatabaseCockpit,
  health: HealthPanel,
};

/** Human label + one-line summary for the content header of any rail target. */
function sectionMeta(target: ManageRailTarget): { label: string; summary: string } {
  if (target === OPTIONAL_SECTION) {
    return { label: "Optional", summary: "Panels whose plugin or connector isn't active on this site yet." };
  }
  if (isSyntheticSection(target)) {
    const meta = SYNTHETIC_SECTIONS[target];
    return { label: meta.label, summary: meta.summary };
  }
  const def = getPanelDef(target);
  return { label: def?.label ?? target, summary: def?.summary ?? "" };
}

/**
 * The per-site "Manage" console. Every value is read live from the site over the
 * addon's secure in-pod wp-cli path or the signed IWSL Connector channel. The
 * console now uses a full-width VERTICAL grouped section rail (Overview · Content ·
 * People · Extensions · Configuration · Operations · Monitoring · Security) with an
 * Overview status-card landing — replacing the old horizontal tab strip. Only
 * available panels appear; gated ones collapse into the trailing "Optional" entry.
 */
export function ManageView({ site }: { site: string }) {
  const queryClient = useQueryClient();
  const overviewState = useManageOverview(site);
  const overview = overviewState.data;

  // Force renew must refresh BOTH the header overview AND the open panel. The
  // button historically forced only the overview, so a stuck panel (e.g. a big
  // site's media/database that a slow-pod sweep captured as all-zeros) never
  // refreshed. Invalidating the panel queries makes the visible panel re-pull; the
  // server then distrusts any degenerate snapshot and returns live data.
  const forceRenew = () => {
    overviewState.reload(true);
    void queryClient.invalidateQueries({ queryKey: ["wordpress-manage-panel", site] });
  };

  const availablePanelIds = useMemo(() => {
    const set = new Set<ManagePanelId>();
    if (!overview) return set;
    const availableById = new Map(overview.panels.map((p) => [p.id, p.available]));
    for (const panel of MANAGE_PANELS) {
      if (availableById.get(panel.id) !== false) set.add(panel.id);
    }
    return set;
  }, [overview]);

  const groups = useMemo(() => buildVisibleGroups(availablePanelIds), [availablePanelIds]);
  const visibleSectionIds = useMemo(() => new Set(flattenSections(groups)), [groups]);
  const disabledCount = useMemo(
    () => (overview ? overview.panels.filter((p) => !p.available).length : 0),
    [overview],
  );

  const [section, setSection] = useState<ManageRailTarget>("overview");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [maintenanceOn, setMaintenanceOn] = useState<boolean | null>(null);

  // Clamp the chosen section during render (no effect) as capabilities resolve:
  // synthetic sections + Optional are always valid; a panel that disappears falls
  // back to the Overview landing.
  const active: ManageRailTarget =
    section === OPTIONAL_SECTION || isSyntheticSection(section)
      ? section
      : visibleSectionIds.has(section)
        ? section
        : "overview";

  const badges = useMemo<Partial<Record<ManageSectionId, number>>>(
    () => (overview ? { updates: overview.pendingUpdates } : {}),
    [overview],
  );

  const select = (target: ManageRailTarget) => {
    setSection(target);
    setMobileNavOpen(false);
  };

  if (overviewState.error) {
    return (
      <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
        <PanelError message={overviewState.error} onRetry={overviewState.reload} />
      </section>
    );
  }

  const meta = sectionMeta(active);
  const updatedLabel = overview ? formatUpdatedAt(overview.cachedAt) : null;

  const renderBody = () => {
    if (!overview) return <PanelSkeleton />;
    if (active === OPTIONAL_SECTION) {
      return <OptionalDisabledPanel site={site} overview={overview} onEnabled={overviewState.reload} />;
    }
    if (active === "overview") {
      return <OverviewLanding overview={overview} visibleSections={visibleSectionIds} onNavigate={select} />;
    }
    if (active === "settings") {
      return (
        <SettingsPanel
          site={site}
          maintenanceOn={maintenanceOn}
          onMaintenanceChange={setMaintenanceOn}
          onSaved={() => overviewState.reload()}
        />
      );
    }
    const ActivePanel = PANEL_COMPONENTS[active];
    return ActivePanel ? <ActivePanel site={site} /> : null;
  };

  return (
    <MotionConfig reducedMotion="user">
      <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
        {/* Header — title, freshness line + Force renew (preserved). */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-zinc-900 dark:text-zinc-100">
            <Wand2 className="h-5 w-5 text-sky-500" aria-hidden />
            <h2 className="text-lg font-medium">Manage</h2>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span>
              {overview
                ? `${updatedLabel ? `Updated ${updatedLabel} · ` : ""}${overview.activePlugins} active plugins · ${visibleSectionIds.size} sections`
                : "Reading site…"}
            </span>
            <button
              type="button"
              onClick={forceRenew}
              disabled={overviewState.loading}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              title="Pull the site's live current info now (bypasses the cached snapshot)"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", overviewState.loading && "animate-spin")} aria-hidden />
              Force renew
            </button>
          </div>
        </div>

        {maintenanceOn === true ? (
          <div
            role="status"
            className="mt-4 flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-800 dark:text-amber-200"
          >
            <Wrench className="h-4 w-4 shrink-0" aria-hidden />
            <span className="font-medium">Maintenance mode is on</span>
            <span className="text-amber-700/90 dark:text-amber-300/80">— visitors see a maintenance notice.</span>
          </div>
        ) : null}

        {/* Mobile: section switcher (accordion, never a horizontal scroll strip). */}
        <div className="mt-4 lg:hidden">
          <button
            type="button"
            onClick={() => setMobileNavOpen((v) => !v)}
            aria-expanded={mobileNavOpen}
            aria-controls="manage-mobile-nav"
            className="flex w-full items-center justify-between gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3.5 py-2.5 text-sm font-medium text-zinc-800 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-100"
          >
            <span>
              Section: <span className="text-sky-600 dark:text-sky-400">{meta.label}</span>
            </span>
            <ChevronDown className={cn("h-4 w-4 transition-transform", mobileNavOpen && "rotate-180")} aria-hidden />
          </button>
          {mobileNavOpen ? (
            <div
              id="manage-mobile-nav"
              className="mt-2 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900/60"
            >
              {overview ? (
                <SectionNav
                  groups={groups}
                  active={active}
                  onSelect={select}
                  badges={badges}
                  optionalCount={disabledCount}
                  idPrefix="drawer"
                  panelId={SECTION_PANEL_ID}
                />
              ) : (
                <SectionNavSkeleton />
              )}
            </div>
          ) : null}
        </div>

        {/* Desktop: two-pane — vertical rail + wide content. */}
        <div className="mt-5 grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
          <aside className="hidden lg:block">
            <div className="sticky top-6">
              {overview ? (
                <SectionNav
                  groups={groups}
                  active={active}
                  onSelect={select}
                  badges={badges}
                  optionalCount={disabledCount}
                  idPrefix="rail"
                  panelId={SECTION_PANEL_ID}
                />
              ) : (
                <SectionNavSkeleton />
              )}
            </div>
          </aside>

          <div className="min-w-0">
            <div className="mb-4 border-b border-zinc-200 pb-3 dark:border-zinc-800">
              <h3 id={SECTION_TITLE_ID} className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
                {meta.label}
              </h3>
              {meta.summary ? <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">{meta.summary}</p> : null}
            </div>

            <section role="region" id={SECTION_PANEL_ID} aria-labelledby={SECTION_TITLE_ID}>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={active}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.22, ease: EASE_OUT }}
                >
                  {renderBody()}
                </motion.div>
              </AnimatePresence>
            </section>
          </div>
        </div>
      </section>
    </MotionConfig>
  );
}
