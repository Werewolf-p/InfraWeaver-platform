"use client";
import { motion } from "framer-motion";
import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRBAC } from "@/hooks/use-rbac";
import { toast } from "sonner";
import { Save, Code, ToggleLeft, ToggleRight, GitCommit } from "lucide-react";
import { cn } from "@/lib/utils";
import dynamic from "next/dynamic";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

const CATALOG_APPS = [
  { name: "wiki", description: "Wiki.js documentation", url: "wiki.int.rlservers.com", icon: "📚" },
  { name: "gatus", description: "Status monitoring", url: "gatus.int.rlservers.com", icon: "💚" },
  { name: "stirling-pdf", description: "PDF tools", url: "stirling-pdf.int.rlservers.com", icon: "📄" },
  { name: "onedev", description: "Git forge + CI", url: "onedev.rlservers.com", icon: "🔧" },
  { name: "vaultwarden", description: "Password manager", url: "vaultwarden.int.rlservers.com", icon: "🔐" },
  { name: "gitea", description: "Self-hosted Git", url: "gitea.int.rlservers.com", icon: "🐱" },
  { name: "it-tools", description: "IT/Dev tools", url: "it-tools.int.rlservers.com", icon: "🔨" },
  { name: "excalidraw", description: "Whiteboard", url: "excalidraw.int.rlservers.com", icon: "✏️" },
  { name: "uptime-kuma", description: "Uptime monitoring", url: "uptime-kuma.int.rlservers.com", icon: "⏱️" },
  { name: "actual", description: "Personal finance", url: "actual.int.rlservers.com", icon: "💰" },
  { name: "outline", description: "Team knowledge base", url: "outline.int.rlservers.com", icon: "📝" },
  { name: "jellyfin", description: "Media server", url: "jellyfin.int.rlservers.com", icon: "🎬" },
];

export default function ConfigPage() {
  const { can, isAdmin } = useRBAC();
  const [activeTab, setActiveTab] = useState<"catalog" | "groups" | "yaml">("catalog");
  const [enabledApps, setEnabledApps] = useState<Set<string>>(new Set());
  const [pendingChanges, setPendingChanges] = useState<string[]>([]);
  const [yamlContent, setYamlContent] = useState("");
  const [showCommitDialog, setShowCommitDialog] = useState(false);

  const { data: platformConfig } = useQuery({
    queryKey: ["config", "platform"],
    queryFn: async () => {
      const res = await fetch("/api/config/platform");
      if (!res.ok) throw new Error("Failed to load config");
      return res.json();
    },
  });

  useEffect(() => {
    if (platformConfig) {
      setEnabledApps(new Set(platformConfig.catalog?.enabled ?? []));
      setYamlContent(platformConfig.raw ?? "");
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
  };

  type TabId = "catalog" | "groups" | "yaml";
  const tabs: { id: TabId; label: string; icon: React.ElementType }[] = [
    { id: "catalog", label: "Catalog Manager", icon: ToggleLeft },
    { id: "groups", label: "Groups", icon: ToggleRight },
    ...(isAdmin ? [{ id: "yaml" as TabId, label: "Raw YAML", icon: Code }] : []),
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-white">Platform Config</h2>
          <p className="text-sm text-slate-400">Manage catalog apps, groups, and platform settings</p>
        </div>
        {pendingChanges.length > 0 && can("catalog:write") && (
          <button
            onClick={() => setShowCommitDialog(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-500 text-white text-sm font-medium hover:bg-indigo-600 transition-colors"
          >
            <GitCommit className="w-4 h-4" />
            Commit {pendingChanges.length} change{pendingChanges.length !== 1 ? "s" : ""}
          </button>
        )}
      </div>

      <div className="flex gap-1 bg-white/5 rounded-lg p-1 mb-6 w-fit">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              "flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors",
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

      {activeTab === "catalog" && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4"
        >
          {CATALOG_APPS.map(app => {
            const isEnabled = enabledApps.has(app.name);
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
                    <span className="text-2xl mb-1 block">{app.icon}</span>
                    <h3 className="text-sm font-semibold text-white">{app.name}</h3>
                    <p className="text-xs text-slate-400 mt-0.5">{app.description}</p>
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
                <div className={cn("text-xs px-2 py-0.5 rounded-full w-fit font-medium", isEnabled ? "bg-green-500/10 text-green-400" : "bg-slate-500/10 text-slate-500")}>
                  {isEnabled ? "Enabled" : "Disabled"}
                </div>
                <p className="text-xs text-slate-500 mt-1 truncate">{app.url}</p>
              </motion.div>
            );
          })}
        </motion.div>
      )}

      {activeTab === "groups" && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
          {[
            { name: "core-monitoring", description: "Prometheus, Loki, Alertmanager — cluster observability", enabled: platformConfig?.groups?.["core-monitoring"]?.enabled ?? true },
            { name: "core-platform", description: "SSO, VPN, DNS, Homepage, Backups — core platform services", enabled: platformConfig?.groups?.["core-platform"]?.enabled ?? true },
          ].map(group => (
            <div key={group.name} className="bg-white/5 border border-white/10 rounded-xl p-5 flex items-center justify-between">
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

      {activeTab === "yaml" && isAdmin && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="bg-white/5 border border-white/10 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
            <span className="text-sm font-medium text-white">platform.yaml</span>
            <button
              onClick={() => toast.info("YAML commit flow coming soon")}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 text-xs font-medium"
            >
              <Save className="w-3.5 h-3.5" />
              Save & Commit
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
              {pendingChanges.map((c, i) => (
                <div key={i} className="flex items-center gap-2 text-sm text-slate-300">
                  <span className="w-2 h-2 rounded-full bg-indigo-400 flex-shrink-0" />
                  {c}
                </div>
              ))}
            </div>
            <p className="text-xs text-slate-400 mb-4">This will commit changes to platform.yaml and push to main. ArgoCD will auto-sync.</p>
            <div className="flex gap-3">
              <button
                onClick={() => commitMutation.mutate(`chore: ${pendingChanges.join(", ")} via InfraWeaver Console`)}
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
