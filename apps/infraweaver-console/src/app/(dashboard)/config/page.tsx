"use client";
import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRBAC } from "@/hooks/use-rbac";
import { toast } from "sonner";
import { Save, Code, ToggleLeft, ToggleRight, GitCommit, Loader2, CheckCircle2, XCircle, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import dynamic from "next/dynamic";
import * as jsYaml from "js-yaml";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

interface CatalogApp {
  name: string;
  description: string;
  host: string;
}

const APP_ICONS: Record<string, string> = {
  wiki: "📚", gatus: "💚", "stirling-pdf": "📄", onedev: "🔧",
  vaultwarden: "🔐", gitea: "🐱", "it-tools": "🔨", excalidraw: "✏️",
  "uptime-kuma": "⏱️", actual: "💰", outline: "📝", jellyfin: "🎬",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ParsedConfig = Record<string, any>;

export default function ConfigPage() {
  const { can, isAdmin } = useRBAC();
  const [activeTab, setActiveTab] = useState<"core" | "catalog" | "groups" | "yaml">("catalog");
  const [enabledApps, setEnabledApps] = useState<Set<string>>(new Set());
  const [pendingChanges, setPendingChanges] = useState<string[]>([]);
  const [yamlContent, setYamlContent] = useState("");
  const [showCommitDialog, setShowCommitDialog] = useState(false);
  const [parsedConfig, setParsedConfig] = useState<ParsedConfig | null>(null);
  const [groupsYamlPending, setGroupsYamlPending] = useState(false);

  const { data: platformConfig } = useQuery({
    queryKey: ["config", "platform"],
    queryFn: async () => {
      const res = await fetch("/api/config/platform");
      if (!res.ok) throw new Error("Failed to load config");
      return res.json();
    },
  });

  const { data: catalogApps, isLoading: catalogLoading } = useQuery<CatalogApp[]>({
    queryKey: ["config", "catalog-apps"],
    queryFn: async () => {
      const res = await fetch("/api/config/catalog-apps");
      if (!res.ok) throw new Error("Failed to load catalog");
      return res.json();
    },
  });

  useEffect(() => {
    if (platformConfig) {
      setEnabledApps(new Set(platformConfig.catalog?.enabled ?? []));
      setYamlContent(platformConfig.raw ?? "");
      try {
        const loaded = jsYaml.load(platformConfig.raw ?? "") as ParsedConfig;
        setParsedConfig(loaded ?? {});
      } catch {
        setParsedConfig({});
      }
    }
  }, [platformConfig]);

  const commitMutation = useMutation({
    mutationFn: async (message: string) => {
      const res = await fetch("/api/config/platform", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes: pendingChanges, commitMessage: message }),
      });
      if (!res.ok) throw new Error("Commit failed");
      return res.json();
    },
    onSuccess: () => {
      toast.success("Changes committed to git! ArgoCD will sync shortly.");
      setPendingChanges([]);
      setShowCommitDialog(false);
    },
    onError: () => toast.error("Failed to commit changes"),
  });

  const yamlCommitMutation = useMutation({
    mutationFn: async (content?: string) => {
      const res = await fetch("/api/config/platform", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          yamlContent: content ?? yamlContent,
          commitMessage: "chore: update platform.yaml via InfraWeaver Console",
        }),
      });
      if (!res.ok) throw new Error("YAML commit failed");
      return res.json();
    },
    onSuccess: () => {
      toast.success("platform.yaml saved & committed to git!");
      setGroupsYamlPending(false);
    },
    onError: () => toast.error("Failed to save YAML"),
  });

  const toggleApp = (appName: string) => {
    if (!can("catalog:write")) {
      toast.error("Insufficient permissions");
      return;
    }
    const newEnabled = new Set(enabledApps);
    if (newEnabled.has(appName)) {
      newEnabled.delete(appName);
      setPendingChanges(prev => [...prev.filter(c => c !== `Enable ${appName}`), `Disable ${appName}`]);
    } else {
      newEnabled.add(appName);
      setPendingChanges(prev => [...prev.filter(c => c !== `Disable ${appName}`), `Enable ${appName}`]);
    }
    setEnabledApps(newEnabled);
    // Also update parsedConfig
    if (parsedConfig) {
      const next = { ...parsedConfig };
      if (!next.catalog) next.catalog = {};
      if (!Array.isArray(next.catalog.enabled)) next.catalog.enabled = [];
      if (newEnabled.has(appName)) {
        if (!next.catalog.enabled.includes(appName)) next.catalog.enabled.push(appName);
      } else {
        next.catalog.enabled = next.catalog.enabled.filter((a: string) => a !== appName);
      }
      setParsedConfig(next);
    }
  };

  const setCatalogReplicas = (appName: string, replicas: number) => {
    if (!parsedConfig) return;
    const next = { ...parsedConfig };
    if (!next.catalog) next.catalog = {};
    if (!next.catalog.ha) next.catalog.ha = {};
    if (!next.catalog.ha[appName]) next.catalog.ha[appName] = {};
    next.catalog.ha[appName].replicas = replicas;
    setParsedConfig(next);
    setPendingChanges(prev => {
      const filtered = prev.filter(c => !c.startsWith(`Set replicas catalog:${appName}:`));
      return [...filtered, `Set replicas catalog:${appName}:${replicas}`];
    });
  };

  const toggleGroup = (groupName: string) => {
    if (!can("catalog:write")) {
      toast.error("Insufficient permissions");
      return;
    }
    if (!parsedConfig) return;
    const next = { ...parsedConfig };
    if (!next.groups) next.groups = {};
    if (!next.groups[groupName]) next.groups[groupName] = {};
    next.groups[groupName] = { ...next.groups[groupName], enabled: !next.groups[groupName].enabled };
    setParsedConfig(next);
    setGroupsYamlPending(true);
  };

  const setGroupReplicas = (groupName: string, appName: string, replicas: number) => {
    if (!parsedConfig) return;
    const next = { ...parsedConfig };
    if (!next.groups?.[groupName]?.apps?.[appName]) return;
    next.groups[groupName].apps[appName] = { ...next.groups[groupName].apps[appName], replicas };
    setParsedConfig(next);
    setGroupsYamlPending(true);
  };

  const saveGroupsAndCatalog = () => {
    if (!parsedConfig) return;
    const content = jsYaml.dump(parsedConfig, { lineWidth: -1, indent: 2 });
    yamlCommitMutation.mutate(content);
    setPendingChanges([]);
  };

  type TabId = "core" | "catalog" | "groups" | "yaml";
  const tabs: { id: TabId; label: string; icon: React.ElementType; lockIcon?: boolean }[] = [
    { id: "core", label: "Core Apps", icon: Lock, lockIcon: true },
    { id: "catalog", label: "Catalog Manager", icon: ToggleLeft },
    { id: "groups", label: "Groups", icon: ToggleRight },
    ...(isAdmin ? [{ id: "yaml" as TabId, label: "Raw YAML", icon: Code }] : []),
  ];

  const coreApps = parsedConfig?.core?.apps as Record<string, { description: string }> | undefined;
  const groupsData = parsedConfig?.groups as Record<string, {
    description?: string;
    enabled?: boolean;
    apps?: Record<string, { description?: string; replicas?: number }>;
  }> | undefined;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-white">Platform Config</h2>
          <p className="text-sm text-slate-400">Manage catalog apps, groups, and platform settings</p>
        </div>
        <div className="flex items-center gap-3">
          {(groupsYamlPending || pendingChanges.some(c => c.startsWith("Set replicas catalog:"))) && can("catalog:write") && (
            <button
              onClick={saveGroupsAndCatalog}
              disabled={yamlCommitMutation.isPending}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 transition-colors disabled:opacity-50"
            >
              {yamlCommitMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save Changes
            </button>
          )}
          {pendingChanges.filter(c => !c.startsWith("Set replicas")).length > 0 && can("catalog:write") && (
            <button
              onClick={() => setShowCommitDialog(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-500 text-white text-sm font-medium hover:bg-indigo-600 transition-colors"
            >
              <GitCommit className="w-4 h-4" />
              Commit {pendingChanges.filter(c => !c.startsWith("Set replicas")).length} change{pendingChanges.filter(c => !c.startsWith("Set replicas")).length !== 1 ? "s" : ""}
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-1 bg-white/5 rounded-lg p-1 mb-6 w-fit overflow-x-auto max-w-full scrollbar-none">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors flex-shrink-0",
              activeTab === tab.id
                ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
                : "text-slate-400 hover:text-white"
            )}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Core Apps Tab */}
      {activeTab === "core" && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <div className="mb-4 flex items-center gap-2 text-sm text-slate-400">
            <Lock className="w-4 h-4 text-slate-500" />
            <span>Core apps are always enabled and cannot be toggled. They are required for platform operation.</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {coreApps
              ? Object.entries(coreApps).map(([name, { description }]) => (
                  <div key={name} className="bg-white/5 border border-green-500/20 rounded-xl p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <span className="text-2xl mb-1 block">⚙️</span>
                        <h3 className="text-sm font-semibold text-white">{name}</h3>
                        <p className="text-xs text-slate-400 mt-0.5">{description}</p>
                      </div>
                      <Lock className="w-4 h-4 text-slate-600 flex-shrink-0 mt-1" />
                    </div>
                    <div className="text-xs px-2 py-0.5 rounded-full w-fit font-medium bg-green-500/10 text-green-400">
                      Always On
                    </div>
                  </div>
                ))
              : [...Array(8)].map((_, i) => (
                  <div key={i} className="h-32 rounded-xl bg-white/5 animate-pulse" />
                ))}
          </div>
        </motion.div>
      )}

      {/* Catalog Manager Tab */}
      {activeTab === "catalog" && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4"
        >
          {catalogLoading
            ? [...Array(8)].map((_, i) => (
                <div key={i} className="h-32 rounded-xl bg-white/5 animate-pulse" />
              ))
            : (catalogApps ?? []).map(app => {
                const isEnabled = enabledApps.has(app.name);
                const icon = APP_ICONS[app.name] ?? "📦";
                const replicas = (parsedConfig?.catalog?.ha?.[app.name]?.replicas as number | undefined) ?? 1;
                return (
                  <motion.div
                    key={app.name}
                    whileHover={{ scale: 1.01 }}
                    className={cn(
                      "bg-white/5 border rounded-xl p-4 transition-colors",
                      isEnabled ? "border-green-500/20" : "border-white/5"
                    )}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <span className="text-2xl mb-1 block">{icon}</span>
                        <h3 className="text-sm font-semibold text-white">{app.name}</h3>
                        <p className="text-xs text-slate-400 mt-0.5">{app.description || "Catalog app"}</p>
                      </div>
                      <button
                        onClick={() => toggleApp(app.name)}
                        disabled={!can("catalog:write")}
                        className="flex-shrink-0"
                      >
                        {isEnabled ? (
                          <ToggleRight className="w-7 h-7 text-green-400" />
                        ) : (
                          <ToggleLeft className="w-7 h-7 text-slate-600" />
                        )}
                      </button>
                    </div>
                    <div className={cn("text-xs px-2 py-0.5 rounded-full w-fit font-medium mb-2", isEnabled ? "bg-green-500/10 text-green-400" : "bg-slate-500/10 text-slate-500")}>
                      {isEnabled ? "Enabled" : "Disabled"}
                    </div>
                    {app.host && <p className="text-xs text-slate-500 mt-1 truncate">{app.host}</p>}
                    {isEnabled && (
                      <div className="mt-2 flex items-center gap-2">
                        <span className="text-xs text-slate-500">Replicas</span>
                        <input
                          type="number"
                          min={1}
                          max={5}
                          value={replicas}
                          onChange={e => setCatalogReplicas(app.name, Number(e.target.value))}
                          disabled={!can("catalog:write")}
                          className="w-14 bg-white/10 border border-white/10 rounded px-2 py-0.5 text-xs text-white focus:outline-none focus:border-indigo-500/50 disabled:opacity-50"
                        />
                      </div>
                    )}
                  </motion.div>
                );
              })}
        </motion.div>
      )}

      {/* Groups Tab */}
      {activeTab === "groups" && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
          {groupsData
            ? Object.entries(groupsData).map(([groupName, group]) => {
                const isEnabled = group.enabled ?? true;
                const apps = group.apps ?? {};
                return (
                  <div key={groupName} className="bg-white/5 border border-white/10 rounded-xl p-5">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h3 className="text-sm font-semibold text-white">{groupName}</h3>
                        {group.description && <p className="text-xs text-slate-400 mt-0.5">{group.description}</p>}
                      </div>
                      <button
                        onClick={() => toggleGroup(groupName)}
                        disabled={!can("catalog:write")}
                        className="flex-shrink-0 disabled:opacity-50"
                      >
                        {isEnabled ? (
                          <ToggleRight className="w-8 h-8 text-green-400" />
                        ) : (
                          <ToggleLeft className="w-8 h-8 text-slate-600" />
                        )}
                      </button>
                    </div>
                    {Object.keys(apps).length > 0 && (
                      <div className="space-y-2">
                        {Object.entries(apps).map(([appName, appData]) => (
                          <div key={appName} className="flex items-center justify-between bg-white/5 rounded-lg px-3 py-2">
                            <div>
                              <span className="text-xs font-medium text-white">{appName}</span>
                              {appData.description && (
                                <p className="text-xs text-slate-500">{appData.description}</p>
                              )}
                            </div>
                            {appData.replicas !== undefined && (
                              <div className="flex items-center gap-2">
                                <span className="text-xs text-slate-500">Replicas</span>
                                <input
                                  type="number"
                                  min={1}
                                  max={5}
                                  value={appData.replicas}
                                  onChange={e => setGroupReplicas(groupName, appName, Number(e.target.value))}
                                  disabled={!can("catalog:write")}
                                  className="w-14 bg-white/10 border border-white/10 rounded px-2 py-0.5 text-xs text-white focus:outline-none focus:border-indigo-500/50 disabled:opacity-50"
                                />
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            : [
                { name: "core-monitoring", description: "Prometheus, Loki, Alertmanager — cluster observability", enabled: platformConfig?.groups?.["core-monitoring"]?.enabled ?? true },
                { name: "core-platform", description: "SSO, VPN, DNS, Homepage, Backups — core platform services", enabled: platformConfig?.groups?.["core-platform"]?.enabled ?? true },
              ].map(group => (
                <div key={group.name} className="bg-white/5 border border-white/10 rounded-xl p-5 flex items-center justify-between animate-pulse">
                  <div>
                    <h3 className="text-sm font-semibold text-white">{group.name}</h3>
                    <p className="text-xs text-slate-400 mt-0.5">{group.description}</p>
                  </div>
                  <div className={cn("text-xs px-3 py-1 rounded-full font-medium", group.enabled ? "bg-green-500/10 text-green-400" : "bg-slate-500/10 text-slate-500")}>
                    {group.enabled ? "Enabled" : "Disabled"}
                  </div>
                </div>
              ))}
        </motion.div>
      )}

      {/* Raw YAML Tab */}
      {activeTab === "yaml" && isAdmin && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium text-white">platform.yaml</span>
              {yamlContent && (() => {
                try { jsYaml.load(yamlContent); return <span className="flex items-center gap-1 text-xs text-green-400"><CheckCircle2 className="w-3.5 h-3.5" />Valid YAML</span>; }
                catch { return <span className="flex items-center gap-1 text-xs text-red-400"><XCircle className="w-3.5 h-3.5" />Invalid YAML</span>; }
              })()}
            </div>
            <button
              onClick={() => yamlCommitMutation.mutate(undefined)}
              disabled={yamlCommitMutation.isPending || !can("catalog:write")}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 text-xs font-medium hover:bg-indigo-500/30 transition-colors disabled:opacity-50"
            >
              {yamlCommitMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              {yamlCommitMutation.isPending ? "Saving..." : "Save & Commit"}
            </button>
          </div>
          <MonacoEditor
            height="500px"
            language="yaml"
            theme="vs-dark"
            value={yamlContent}
            onChange={v => setYamlContent(v ?? "")}
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: "on",
              lineNumbers: "on",
              renderLineHighlight: "all",
            }}
          />
        </motion.div>
      )}

      {showCommitDialog && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <motion.div
            initial={{ scale: 0.95, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="bg-slate-900 border border-white/10 rounded-2xl p-6 w-full max-w-md shadow-2xl"
          >
            <h3 className="text-lg font-semibold text-white mb-4">Commit Changes</h3>
            <div className="space-y-2 mb-4">
              {pendingChanges.filter(c => !c.startsWith("Set replicas")).map((c, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-slate-300">
                  <span className="w-2 h-2 rounded-full bg-indigo-400 flex-shrink-0" />
                  {c}
                </div>
              ))}
            </div>
            <p className="text-xs text-slate-400 mb-4">This will commit changes to platform.yaml and push to main. ArgoCD will auto-sync.</p>
            <div className="flex gap-3">
              <button
                onClick={() => commitMutation.mutate(`chore: ${pendingChanges.filter(c => !c.startsWith("Set replicas")).join(", ")} via InfraWeaver Console`)}
                disabled={commitMutation.isPending}
                className="flex-1 py-2.5 rounded-lg bg-indigo-500 text-white text-sm font-medium hover:bg-indigo-600 transition-colors disabled:opacity-50"
              >
                {commitMutation.isPending ? "Committing..." : "Confirm & Commit"}
              </button>
              <button
                onClick={() => setShowCommitDialog(false)}
                className="flex-1 py-2.5 rounded-lg bg-white/5 border border-white/10 text-slate-300 text-sm font-medium"
              >
                Cancel
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
