"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import { Cpu, Database, Gauge, Puzzle, RefreshCw, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { EASE_OUT } from "../motion";
import { HealthGauge, StatTile, healthTone } from "../widgets";
import { MANAGE_PANELS, type ManagePanelId } from "../../../lib/manage/capabilities";
import { PanelError, PanelSkeleton } from "./panel-shell";
import { OptionalDisabledPanel } from "./panel-optional";
import {
  ManageTabRail,
  MANAGE_TABPANEL_ID,
  OPTIONAL_TAB,
  manageTabButtonId,
  type ManageTab,
} from "./tab-rail";
import { useManageOverview } from "./use-manage";
import { UpdatesPanel } from "./panels-updates";
import { InventoryPanel } from "./panels-inventory";
import { ContentPanel } from "./panels-content";
import { MediaPanel } from "./panels-media";
import { StorePanel } from "./panels-store";
import { FormsPanel } from "./panels-forms";
import { BackupsPanel } from "./panels-backups";
import { StagingPanel } from "./panels-staging";
import { SecurityPanel } from "./panels-security";
import { AuditPanel } from "./panels-audit";
import { PerformancePanel } from "./panels-performance";
import { ResourcesPanel } from "./panels-resources";
import { UptimePanel } from "./panels-uptime";
import { MetricsPanel } from "./panels-metrics";
import { AudiencePanel } from "./panels-audience";
import { EmailPanel } from "./panels-email";
import { PeoplePanel } from "./panels-people";
import { ClientsPanel } from "./panels-clients";
import { AlertsPanel } from "./panels-alerts";
import { LogsPanel } from "./panels-logs";
import { DataPanel } from "./panels-data";
import { HealthPanel } from "./panels-health";

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
  media: MediaPanel,
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
  data: DataPanel,
  health: HealthPanel,
};

/**
 * The per-site "Manage" console. Every value is read live from the site over the
 * addon's secure in-pod wp-cli path or the signed IWSL Connector channel — the
 * overview here detects which optional capabilities are present, so the tab strip
 * only shows panels the site can actually answer for and the rest move to the
 * "Optional (Disabled)" tab.
 */
export function ManageView({ site }: { site: string }) {
  const overviewState = useManageOverview(site);
  const overview = overviewState.data;

  const visiblePanels = useMemo(() => {
    if (!overview) return [];
    const availableById = new Map(overview.panels.map((p) => [p.id, p.available]));
    return MANAGE_PANELS.filter((panel) => availableById.get(panel.id) !== false);
  }, [overview]);

  const disabledCount = useMemo(() => {
    if (!overview) return 0;
    return overview.panels.filter((p) => !p.available).length;
  }, [overview]);

  const [tab, setTab] = useState<ManageTab>("updates");

  // Derive the effective tab during render (no effect): clamp the user's choice
  // to a still-visible panel as capabilities resolve or change (e.g. after
  // enabling one), so a tab that disappears falls back to the first available.
  const activeTab: ManageTab =
    tab === OPTIONAL_TAB
      ? OPTIONAL_TAB
      : visiblePanels.some((p) => p.id === tab)
        ? tab
        : visiblePanels[0]?.id ?? tab;

  if (overviewState.error) {
    return (
      <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
        <PanelError message={overviewState.error} onRetry={overviewState.reload} />
      </section>
    );
  }

  const ActivePanel = activeTab !== OPTIONAL_TAB ? PANEL_COMPONENTS[activeTab] : null;

  return (
    <MotionConfig reducedMotion="user">
      <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-zinc-900 dark:text-zinc-100">
            <Wand2 className="h-5 w-5 text-sky-500" aria-hidden />
            <h2 className="text-lg font-medium">Manage</h2>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span>
              {overview
                ? `${formatUpdatedAt(overview.cachedAt) ? `Updated ${formatUpdatedAt(overview.cachedAt)} · ` : ""}${overview.activePlugins} active plugins · ${visiblePanels.length} panels`
                : "Reading site…"}
            </span>
            <button
              type="button"
              onClick={() => overviewState.reload(true)}
              disabled={overviewState.loading}
              className="inline-flex items-center gap-1 rounded-md border border-zinc-200 px-2 py-1 font-medium text-zinc-600 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              title="Pull the site's live current info now (bypasses the cached snapshot)"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", overviewState.loading && "animate-spin")} aria-hidden />
              Force renew
            </button>
          </div>
        </div>

        <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
          Everything InfraWeaver manages on this WordPress site — updates, content, backups, security, performance,
          users, database and health — read live from the site over the secure Connector path.
        </p>

        {/* At-a-glance summary */}
        <div className="mt-4 grid gap-4 md:grid-cols-[auto_1fr]">
          <div className="flex items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
            <HealthGauge score={overview?.health ?? 0} size={112} strokeWidth={10} label="site health" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Pending updates"
              value={overview?.pendingUpdates ?? 0}
              icon={RefreshCw}
              tone={healthTone(
                (overview?.pendingUpdates ?? 0) === 0 ? 96 : (overview?.pendingUpdates ?? 0) < 4 ? 74 : 46,
              )}
            />
            <StatTile
              label="Active plugins"
              value={overview?.activePlugins ?? 0}
              icon={Puzzle}
              tone={healthTone(80)}
            />
            <StatTile
              label="Database"
              value={overview?.dbSizeMb ?? 0}
              suffix=" MB"
              icon={Database}
              tone={healthTone(70)}
            />
            <StatTile
              label={overview?.connector.active ? "Connector round-trip" : "PHP"}
              value={
                overview?.connector.active
                  ? overview.connector.lastRoundtripMs ?? 0
                  : Number(overview?.phpVersion?.split(".").slice(0, 2).join(".") ?? 0)
              }
              decimals={overview?.connector.active ? 0 : 1}
              suffix={overview?.connector.active ? " ms" : ""}
              icon={overview?.connector.active ? Cpu : Gauge}
              tone={healthTone(overview?.connector.active ? 85 : 70)}
            />
          </div>
        </div>

        {/* Sub-tabs: dynamic — only installed / has-info panels show as primary
            tabs; gated ones collapse into the trailing "Optional" chip. */}
        <ManageTabRail
          panels={visiblePanels}
          activeTab={activeTab}
          disabledCount={disabledCount}
          onSelect={setTab}
          loading={!overview}
        />

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={activeTab}
            role="tabpanel"
            id={MANAGE_TABPANEL_ID}
            aria-labelledby={manageTabButtonId(activeTab)}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className="mt-5"
          >
            {!overview ? (
              <PanelSkeleton />
            ) : activeTab === OPTIONAL_TAB ? (
              <OptionalDisabledPanel site={site} overview={overview} onEnabled={overviewState.reload} />
            ) : ActivePanel ? (
              <ActivePanel site={site} />
            ) : null}
          </motion.div>
        </AnimatePresence>
      </section>
    </MotionConfig>
  );
}
