"use client";

import { motion } from "framer-motion";
import { useState } from "react";
import {
  AlignJustify,
  CheckCircle2,
  Filter,
  Layout,
  Loader2,
  RefreshCw,
  Settings as SettingsIcon,
  Sliders,
  Sun,
  XCircle,
  Zap,
} from "lucide-react";
import type { ElementType } from "react";
import { PlatformEditorPanel } from "@/components/settings/platform-editor-panel";
import { UdmConnectorCard } from "@/components/settings/udm-connector-card";
import { DensityToggle, PageScaffold, PillTabs, SectionTabs, SettingsCard, ThemeToggle, ToggleSwitch } from "@/components/ui";
import { useSettingsContext, type RefreshInterval } from "@/contexts/settings-context";
import { useSimpleMode } from "@/contexts/simple-mode-context";
import { useApiQuery } from "@/hooks";
import { queryRefetchIntervals, queryStaleTimes } from "@/lib/query-defaults";
import { queryKeys } from "@/lib/query-keys";
import { requirePageConfig } from "@/lib/page-registry";
import { cn } from "@/lib/utils";

const page = requirePageConfig("/settings");

const REFRESH_OPTIONS: { label: string; value: RefreshInterval }[] = [
  { label: "15s", value: 15000 },
  { label: "30s", value: 30000 },
  { label: "60s", value: 60000 },
  { label: "5m", value: 300000 },
];

// Accessible toggle row: card chrome + icon on the left, and the shared
// ToggleSwitch primitive (role="switch" + aria-checked + label wiring) on the
// right, so each switch has a real accessible name instead of a bare button.
function ToggleSettingRow({
  icon: Icon,
  title,
  description,
  checked,
  onChange,
}: {
  icon: ElementType;
  title: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <section className="rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 p-4 sm:p-5">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--az-primary-muted)]">
          <Icon className="h-4 w-4 text-[var(--az-primary)]" />
        </div>
        <ToggleSwitch checked={checked} onChange={onChange} label={title} description={description} className="min-w-0 flex-1" />
      </div>
    </section>
  );
}

function ConnectionStatus({ label, path }: { label: string; path: string }) {
  const { data, isLoading, isError } = useApiQuery<unknown>({
    queryKey: queryKeys.settings.connection(label),
    path,
    retry: 1,
    refetchInterval: queryRefetchIntervals.minute,
    staleTime: queryStaleTimes.short,
  });

  return (
    <div className="flex min-h-[44px] items-center gap-2 rounded-lg bg-gray-100 dark:bg-white/5 px-3 py-2 sm:min-h-0 sm:bg-transparent sm:px-0 sm:py-0">
      {isLoading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-500 dark:text-slate-400" />
      ) : isError || !data ? (
        <XCircle className="h-3.5 w-3.5 text-red-400" />
      ) : (
        <CheckCircle2 className="h-3.5 w-3.5 text-green-400" />
      )}
      <span className={cn("text-sm font-medium sm:text-xs", isLoading ? "text-slate-500 dark:text-slate-400" : isError ? "text-red-400" : "text-green-400")}>
        {label}: {isLoading ? "Checking..." : isError ? "Disconnected" : "Connected"}
      </span>
    </div>
  );
}

export default function SettingsPage() {
  const { settings, updateSetting, mounted } = useSettingsContext();
  const { simpleMode, setSimpleMode } = useSimpleMode();
  const [activeTab, setActiveTab] = useState<"general" | "platform">("general");

  return (
    <PageScaffold
      icon={page.icon}
      title={page.pageTitle ?? page.label}
      description={page.pageDescription ?? page.description}
      loading={!mounted}
      className="space-y-6"
    >
      <div className="space-y-6">
        <SectionTabs
          tabs={[
            { value: "general", label: "General", icon: SettingsIcon },
            { value: "platform", label: "Platform", icon: Sliders },
          ]}
          activeTab={activeTab}
          onTabChange={(value) => setActiveTab(value as "general" | "platform")}
        />

        {activeTab === "general" ? (
          <div className="max-w-3xl space-y-4 sm:space-y-5">
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
              <SettingsCard title="Refresh Interval" description="How often to poll cluster data" icon={RefreshCw}>
                <PillTabs
                  label="Refresh interval"
                  tabs={REFRESH_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }))}
                  active={String(settings.refreshInterval)}
                  onChange={(value) => updateSetting("refreshInterval", Number(value) as RefreshInterval)}
                />
              </SettingsCard>
            </motion.div>

            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.03 }}>
              <ToggleSettingRow
                icon={Layout}
                title="Compact Mode"
                description="Reduce padding in cards for denser view"
                checked={settings.compactMode}
                onChange={(checked) => updateSetting("compactMode", checked)}
              />
            </motion.div>

            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.06 }}>
              <ToggleSettingRow
                icon={Filter}
                title="Show System Apps"
                description="Include core-*, bootstrap-*, and platform-* apps in application views"
                checked={settings.showSystemApps}
                onChange={(checked) => updateSetting("showSystemApps", checked)}
              />
            </motion.div>

            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.09 }}>
              <SettingsCard title="Theme" description="Light, Dark, or follow the system preference" icon={Sun}>
                <ThemeToggle />
              </SettingsCard>
            </motion.div>

            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }}>
              <SettingsCard title="Display Density" description="Control spacing and padding in the UI" icon={AlignJustify}>
                <DensityToggle />
              </SettingsCard>
            </motion.div>

            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
              <ToggleSettingRow
                icon={Zap}
                title="Simple Mode"
                description="Hide advanced form fields across the console"
                checked={simpleMode}
                onChange={setSimpleMode}
              />
            </motion.div>

            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.18 }}>
              <SettingsCard title="Connection Status" description="Quick connectivity checks for core control-plane dependencies" icon={Sliders}>
                <div className="grid gap-2 sm:grid-cols-2">
                  <ConnectionStatus label="ArgoCD" path="/api/argocd/apps" />
                  <ConnectionStatus label="GitHub" path="/api/config/platform" />
                </div>
              </SettingsCard>
            </motion.div>

            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.21 }}>
              <UdmConnectorCard />
            </motion.div>
          </div>
        ) : (
          <PlatformEditorPanel />
        )}
      </div>
    </PageScaffold>
  );
}
