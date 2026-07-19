"use client";

import { useMemo, useState } from "react";
import { AnimatePresence, MotionConfig, motion } from "framer-motion";
import {
  Accessibility,
  Activity,
  Archive,
  BellRing,
  Briefcase,
  Cpu,
  Database,
  FileText,
  Gauge,
  GitBranch,
  HeartPulse,
  Image as ImageIcon,
  Inbox,
  Mail,
  Puzzle,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  ShoppingCart,
  TrendingUp,
  Users,
  Wand2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DemoBanner, DummyBadge } from "../DummyBadge";
import { EASE_OUT } from "../motion";
import { HealthGauge, StatTile, healthTone } from "../widgets";
import { getSiteManageData } from "../site-manage-data";
import { getSiteManageExt } from "../site-manage-ext-data";
import { UpdatesPanel } from "./panels-updates";
import { InventoryPanel } from "./panels-inventory";
import { BackupsPanel } from "./panels-backups";
import { SecurityPanel } from "./panels-security";
import { PerformancePanel } from "./panels-performance";
import { AudiencePanel } from "./panels-audience";
import { PeoplePanel } from "./panels-people";
import { DataPanel } from "./panels-data";
import { HealthPanel } from "./panels-health";
import { ContentPanel } from "./panels-content";
import { MediaPanel } from "./panels-media";
import { StorePanel } from "./panels-store";
import { FormsPanel } from "./panels-forms";
import { StagingPanel } from "./panels-staging";
import { AuditPanel } from "./panels-audit";
import { ResourcesPanel } from "./panels-resources";
import { UptimePanel } from "./panels-uptime";
import { EmailPanel } from "./panels-email";
import { ClientsPanel } from "./panels-clients";
import { AlertsPanel } from "./panels-alerts";
import { LogsPanel } from "./panels-logs";

type ManageTab =
  | "updates"
  | "inventory"
  | "content"
  | "media"
  | "store"
  | "forms"
  | "backups"
  | "staging"
  | "security"
  | "audit"
  | "performance"
  | "resources"
  | "uptime"
  | "audience"
  | "email"
  | "people"
  | "clients"
  | "alerts"
  | "logs"
  | "data"
  | "health";

const TABS: ReadonlyArray<{ id: ManageTab; label: string; icon: React.ElementType }> = [
  { id: "updates", label: "Updates", icon: RefreshCw },
  { id: "inventory", label: "Plugins & Themes", icon: Puzzle },
  { id: "content", label: "Content", icon: FileText },
  { id: "media", label: "Media", icon: ImageIcon },
  { id: "store", label: "Store", icon: ShoppingCart },
  { id: "forms", label: "Forms & Leads", icon: Inbox },
  { id: "backups", label: "Backups", icon: Archive },
  { id: "staging", label: "Staging & Deploys", icon: GitBranch },
  { id: "security", label: "Security", icon: ShieldCheck },
  { id: "audit", label: "A11y & SEO Audit", icon: Accessibility },
  { id: "performance", label: "Performance", icon: Gauge },
  { id: "resources", label: "Server Resources", icon: Cpu },
  { id: "uptime", label: "Uptime & Incidents", icon: Activity },
  { id: "audience", label: "Traffic & SEO", icon: TrendingUp },
  { id: "email", label: "Email", icon: Mail },
  { id: "people", label: "Users", icon: Users },
  { id: "clients", label: "Clients & Care", icon: Briefcase },
  { id: "alerts", label: "Alerts", icon: BellRing },
  { id: "logs", label: "Logs", icon: ScrollText },
  { id: "data", label: "Database", icon: Database },
  { id: "health", label: "Health", icon: HeartPulse },
];

/**
 * The per-site "Manage" console preview. Everything here is fake demo data (see
 * site-manage-data.ts + site-manage-ext-data.ts) — it exists to show what a full
 * WordPress-manager surface (à la ManageWP / MainWP / WP Umbrella / GridPane)
 * could look like layered onto InfraWeaver, without touching any real site.
 * Deterministic per site name, SSR-safe.
 */
export function ManageView({ site }: { site: string }) {
  const [tab, setTab] = useState<ManageTab>("updates");
  const data = useMemo(() => getSiteManageData(site), [site]);
  const ext = useMemo(() => getSiteManageExt(site), [site]);

  const pendingUpdates =
    data.plugins.filter((p) => p.updateType).length +
    data.themes.filter((t) => t.updateAvailable).length +
    (data.core.upToDate ? 0 : 1);
  const securityIssues =
    data.plugins.filter((p) => p.updateType === "security").length +
    data.malware.flagged +
    data.plugins.filter((p) => p.vulnerable).length;

  return (
    <MotionConfig reducedMotion="user">
      <section className="mt-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-zinc-900 dark:text-zinc-100">
            <Wand2 className="h-5 w-5 text-sky-500" aria-hidden />
            <h2 className="text-lg font-medium">Manage</h2>
            <DummyBadge />
          </div>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Concept preview · {data.plugins.length} plugins · {data.themes.length} themes
          </span>
        </div>

        <p className="mt-1 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
          A single console for everything a WordPress-management platform does to a site — updates,
          content, commerce, backups, staging, security, performance, uptime, email, users, database
          and health. All values below are illustrative.
        </p>

        <DemoBanner className="mt-4" />

        {/* At-a-glance summary */}
        <div className="mt-4 grid gap-4 md:grid-cols-[auto_1fr]">
          <div className="flex items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
            <HealthGauge score={data.health} size={112} strokeWidth={10} label="site health" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="Pending updates"
              value={pendingUpdates}
              icon={RefreshCw}
              tone={healthTone(pendingUpdates === 0 ? 96 : pendingUpdates < 4 ? 74 : 46)}
            />
            <StatTile
              label="Security issues"
              value={securityIssues}
              icon={ShieldCheck}
              tone={healthTone(securityIssues === 0 ? 96 : securityIssues < 2 ? 62 : 40)}
            />
            <StatTile
              label="PageSpeed (mobile)"
              value={data.pagespeed.mobile}
              icon={Gauge}
              tone={healthTone(data.pagespeed.mobile)}
            />
            <StatTile
              label="Uptime (30d)"
              value={ext.uptime.slaPct}
              decimals={2}
              suffix="%"
              icon={TrendingUp}
              tone={healthTone(ext.uptime.slaPct > 99.9 ? 96 : 70)}
            />
          </div>
        </div>

        {/* Sub-tabs */}
        <div className="mt-5 flex gap-1 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
          {TABS.map((entry) => {
            const on = entry.id === tab;
            const Icon = entry.icon;
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => setTab(entry.id)}
                aria-pressed={on}
                className={cn(
                  "-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 py-2 text-sm transition-colors",
                  on
                    ? "border-sky-500 font-medium text-zinc-900 dark:text-zinc-100"
                    : "border-transparent text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {entry.label}
              </button>
            );
          })}
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className="mt-5"
          >
            {tab === "updates" && <UpdatesPanel data={data} site={site} />}
            {tab === "inventory" && <InventoryPanel data={data} site={site} />}
            {tab === "content" && <ContentPanel ext={ext} site={site} />}
            {tab === "media" && <MediaPanel ext={ext} site={site} />}
            {tab === "store" && <StorePanel ext={ext} site={site} />}
            {tab === "forms" && <FormsPanel ext={ext} site={site} />}
            {tab === "backups" && <BackupsPanel data={data} site={site} />}
            {tab === "staging" && <StagingPanel ext={ext} site={site} />}
            {tab === "security" && <SecurityPanel data={data} site={site} />}
            {tab === "audit" && <AuditPanel ext={ext} site={site} />}
            {tab === "performance" && <PerformancePanel data={data} site={site} />}
            {tab === "resources" && <ResourcesPanel ext={ext} site={site} />}
            {tab === "uptime" && <UptimePanel ext={ext} site={site} />}
            {tab === "audience" && <AudiencePanel data={data} site={site} />}
            {tab === "email" && <EmailPanel ext={ext} site={site} />}
            {tab === "people" && <PeoplePanel data={data} site={site} />}
            {tab === "clients" && <ClientsPanel ext={ext} site={site} />}
            {tab === "alerts" && <AlertsPanel ext={ext} site={site} />}
            {tab === "logs" && <LogsPanel ext={ext} site={site} />}
            {tab === "data" && <DataPanel data={data} site={site} />}
            {tab === "health" && <HealthPanel data={data} site={site} />}
          </motion.div>
        </AnimatePresence>
      </section>
    </MotionConfig>
  );
}
