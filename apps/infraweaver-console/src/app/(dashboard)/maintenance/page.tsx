"use client";
import { motion } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/notify";
import { Settings, Wrench} from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
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
  const canManageMaintenance = can("config:write");
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["maintenance"],
    queryFn: async () => {
      const res = await fetch("/api/apps/maintenance");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ maintenance: MaintenanceEntry[] }>;
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => {
      if (!canManageMaintenance) throw new Error("Forbidden");
      const res = await fetch("/api/apps/maintenance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, active }) });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: (_d, { active }) => {
      toast.success(active ? "Maintenance mode enabled" : "Maintenance mode disabled");
      void qc.invalidateQueries({ queryKey: ["maintenance"] });
    },
    onError: () => toast.error("Failed to update"),
  });

  const entries = data?.maintenance ?? [];
  const active = entries.filter(e => e.active).length;

  if (isLoading) return <div className="space-y-4">{[...Array(3)].map((_, i) => <div key={i} className="h-20 rounded-xl bg-white/5 animate-pulse" />)}</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={Wrench} title="Maintenance" />
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2"><Settings className="w-5 h-5 text-slate-400" />Maintenance Mode Manager</h2>
          <p className="text-sm text-slate-400">Toggle maintenance mode per application</p>
        </div>
        {active > 0 && (
          <span className="px-3 py-1.5 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-sm font-medium">
            {active} app{active > 1 ? "s" : ""} in maintenance
          </span>
        )}
      </div>
      <div className="space-y-3">
        {entries.map(e => (
          <div key={e.id} className={cn("bg-slate-900/60 border rounded-xl backdrop-blur-sm p-4 flex items-center justify-between", e.active ? "border-yellow-500/30" : "border-white/10")}>
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-white">{e.appName}</p>
                <span className="text-xs text-slate-500">{e.namespace}</span>
                {e.active && <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">MAINTENANCE</span>}
              </div>
              <p className="text-xs text-slate-400">{e.message}</p>
              {e.enabledAt && <p className="text-xs text-slate-500">Enabled {new Date(e.enabledAt).toLocaleString()} by {e.enabledBy}</p>}
            </div>
            <button
              onClick={() => toggleMutation.mutate({ id: e.id, active: !e.active })}
              disabled={toggleMutation.isPending || !canManageMaintenance}
              className={cn("px-4 py-2 rounded-lg text-sm font-medium border transition-colors disabled:opacity-50", e.active ? "bg-green-500/20 border-green-500/30 text-green-300 hover:bg-green-500/30" : "bg-yellow-500/20 border-yellow-500/30 text-yellow-300 hover:bg-yellow-500/30")}
            >
              {e.active ? "Disable" : "Enable"}
            </button>
          </div>
        ))}
        {entries.length === 0 && <div className="py-12 text-center text-slate-500 text-sm">No apps configured</div>}
      </div>
    </motion.div>
  );
}
