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
import { PlatformEditorPanel } from "@/components/settings/platform-editor-panel";
import { DensityToggle, PageScaffold, SettingsCard, ThemeToggle } from "@/components/ui";
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

function ToggleButton({ enabled, onClick }: { enabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative flex h-11 w-14 items-center rounded-full transition-colors touch-manipulation",
        enabled ? "bg-indigo-500" : "bg-slate-700",
      )}
    >
      <span
        className={cn(
          "absolute left-1.5 top-1.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
          enabled ? "translate-x-6" : "translate-x-0",
        )}
      />
    </button>
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
    <div className="flex min-h-[44px] items-center gap-2 rounded-lg bg-white/5 px-3 py-2 sm:min-h-0 sm:bg-transparent sm:px-0 sm:py-0">
      {isLoading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
      ) : isError || !data ? (
        <XCircle className="h-3.5 w-3.5 text-red-400" />
      ) : (
        <CheckCircle2 className="h-3.5 w-3.5 text-green-400" />
      )}
      <span className={cn("text-sm font-medium sm:text-xs", isLoading ? "text-slate-400" : isError ? "text-red-400" : "text-green-400")}>
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
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          {([
            { id: "general", label: "General", icon: SettingsIcon },
            { id: "platform", label: "Platform", icon: Sliders },
          ] as const).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={cn(
                "flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors touch-manipulation",
                activeTab === id
                  ? "border border-indigo-500/30 bg-indigo-500/20 text-indigo-300"
                  : "border border-white/10 bg-white/5 text-slate-400 hover:text-white",
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>

        {activeTab === "general" ? (
          <div className="max-w-3xl space-y-4 sm:space-y-5">
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
              <SettingsCard title="Refresh Interval" description="How often to poll cluster data" icon={RefreshCw}>
                <div className="grid grid-cols-2 gap-2 sm:flex">
                  {REFRESH_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => updateSetting("refreshInterval", option.value)}
                      className={cn(
                        "flex min-h-[44px] items-center justify-center rounded-lg px-4 py-2 text-sm font-medium transition-colors touch-manipulation",
                        settings.refreshInterval === option.value
                          ? "border border-indigo-500/30 bg-indigo-500/20 text-indigo-300"
                          : "border border-white/10 bg-white/5 text-slate-400 hover:text-white",
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </SettingsCard>
            </motion.div>

            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.03 }}>
              <SettingsCard
                title="Compact Mode"
                description="Reduce padding in cards for denser view"
                icon={Layout}
                action={<ToggleButton enabled={settings.compactMode} onClick={() => updateSetting("compactMode", !settings.compactMode)} />}
              />
            </motion.div>

            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.06 }}>
              <SettingsCard
                title="Show System Apps"
                description="Include core-*, bootstrap-*, and platform-* apps in application views"
                icon={Filter}
                action={<ToggleButton enabled={settings.showSystemApps} onClick={() => updateSetting("showSystemApps", !settings.showSystemApps)} />}
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
              <SettingsCard
                title="Simple Mode"
                description="Hide advanced form fields across the console"
                icon={Zap}
                action={<ToggleButton enabled={simpleMode} onClick={() => setSimpleMode(!simpleMode)} />}
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
          </div>
        ) : (
          <PlatformEditorPanel />
        )}
      </div>
    </PageScaffold>
  );
}
