"use client";
import { motion } from "framer-motion";
import { Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageScaffold } from "@/components/ui/page-scaffold";
import { useApiMutation, useApiQuery } from "@/hooks/use-api-query";
import { useConfirm } from "@/hooks/use-confirm";
import { useRBAC } from "@/hooks/use-rbac";

interface MaintenanceEntry {
  id: string;
  appName: string;
  namespace: string;
  active: boolean;
  message: string;
  enabledAt?: string;
  enabledBy?: string;
}

export default function MaintenancePage() {
  const { can } = useRBAC();
  const { confirm, confirmDialog } = useConfirm();
  const canManageMaintenance = can("config:write");

  const { data, isLoading } = useApiQuery<{ maintenance: MaintenanceEntry[] }>({
    queryKey: ["maintenance"],
    path: "/api/apps/maintenance",
  });

  const toggleMutation = useApiMutation<unknown, { id: string; active: boolean }>({
    path: "/api/apps/maintenance",
    successMessage: (_d, { active }) => (active ? "Maintenance mode enabled" : "Maintenance mode disabled"),
    errorMessage: "Failed to update",
    invalidateQueryKeys: [["maintenance"]],
  });

  const entries = data?.maintenance ?? [];
  const active = entries.filter(e => e.active).length;

  const handleToggle = async (entry: MaintenanceEntry) => {
    const next = !entry.active;
    const confirmed = await confirm(
      next
        ? {
            title: `Enable maintenance mode for ${entry.appName}?`,
            description: `This takes ${entry.appName} offline for users in ${entry.namespace} and shows a maintenance page until it is disabled.`,
            confirmText: "Enable maintenance",
            danger: true,
          }
        : {
            title: `Disable maintenance mode for ${entry.appName}?`,
            description: `This brings ${entry.appName} back online for users in ${entry.namespace}.`,
            confirmText: "Bring back online",
          },
    );
    if (confirmed) toggleMutation.mutate({ id: entry.id, active: next });
  };

  if (isLoading) return <div className="space-y-4">{[...Array(3)].map((_, i) => <div key={i} className="h-20 rounded-xl bg-gray-100 dark:bg-white/5 animate-pulse" />)}</div>;

  return (
    <PageScaffold
      icon={Wrench}
      title="Maintenance"
      subtitle="Toggle maintenance mode per application"
      actions={
        active > 0 ? (
          <span className="px-3 py-1.5 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-sm font-medium">
            {active} app{active > 1 ? "s" : ""} in maintenance
          </span>
        ) : undefined
      }
    >
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="space-y-3">
        {entries.map(e => (
          <div key={e.id} className={cn("bg-slate-100 dark:bg-slate-900/60 border rounded-xl backdrop-blur-sm p-4 flex items-center justify-between", e.active ? "border-yellow-500/30" : "border-gray-200 dark:border-white/10")}>
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-gray-900 dark:text-white">{e.appName}</p>
                <span className="text-xs text-slate-500">{e.namespace}</span>
                {e.active && <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">MAINTENANCE</span>}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">{e.message}</p>
              {e.enabledAt && <p className="text-xs text-slate-500">Enabled {new Date(e.enabledAt).toLocaleString()} by {e.enabledBy}</p>}
            </div>
            <button
              onClick={() => void handleToggle(e)}
              disabled={toggleMutation.isPending || !canManageMaintenance}
              className={cn("px-4 py-2 rounded-lg text-sm font-medium border transition-colors disabled:opacity-50", e.active ? "bg-green-500/20 border-green-500/30 text-green-300 hover:bg-green-500/30" : "bg-yellow-500/20 border-yellow-500/30 text-yellow-300 hover:bg-yellow-500/30")}
            >
              {e.active ? "Disable" : "Enable"}
            </button>
          </div>
        ))}
        {entries.length === 0 && <div className="py-12 text-center text-slate-500 text-sm">No apps configured</div>}
      </div>
      {confirmDialog}
      </motion.div>
    </PageScaffold>
  );
}
