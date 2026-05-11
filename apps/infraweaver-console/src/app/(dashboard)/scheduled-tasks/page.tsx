"use client";
import { motion } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Clock, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";

interface ScheduledTask {
  id: string;
  name: string;
  namespace: string;
  pod: string;
  schedule: string;
  command: string;
  enabled: boolean;
  lastRun?: string;
  createdAt: string;
}

export default function ScheduledTasksPage() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", namespace: "default", pod: "", schedule: "0 * * * *", command: "ls" });

  const { data, isLoading } = useQuery({
    queryKey: ["scheduled-tasks"],
    queryFn: async () => {
      const res = await fetch("/api/cluster/scheduled-tasks");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ tasks: ScheduledTask[] }>;
    },
  });

  const tasks = data?.tasks ?? [];

  const createMutation = useMutation({
    mutationFn: async (body: typeof form) => {
      const res = await fetch("/api/cluster/scheduled-tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => { toast.success("Task created"); void qc.invalidateQueries({ queryKey: ["scheduled-tasks"] }); setShowForm(false); },
    onError: () => toast.error("Failed to create task"),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/cluster/scheduled-tasks?id=${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => { toast.success("Task deleted"); void qc.invalidateQueries({ queryKey: ["scheduled-tasks"] }); },
    onError: () => toast.error("Failed to delete"),
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const res = await fetch("/api/cluster/scheduled-tasks", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, enabled }) });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["scheduled-tasks"] }),
  });

  if (isLoading) return <div className="space-y-4">{[...Array(3)].map((_, i) => <div key={i} className="h-16 rounded-xl bg-white/5 animate-pulse" />)}</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={Clock} title="Scheduled Tasks" />
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2"><Clock className="w-5 h-5 text-slate-400" />Scheduled Tasks</h2>
          <p className="text-sm text-slate-400">Pod restart and command scheduling</p>
        </div>
        <button onClick={() => setShowForm(v => !v)} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors">
          <Plus className="w-4 h-4" />Add Task
        </button>
      </div>

      {showForm && (
        <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4 space-y-3">
          <h3 className="text-sm font-semibold text-white">New Task</h3>
          {(["name", "namespace", "pod", "schedule", "command"] as const).map(field => (
            <input key={field} value={form[field]} onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))} placeholder={field.charAt(0).toUpperCase() + field.slice(1)} className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50" />
          ))}
          <button onClick={() => createMutation.mutate(form)} disabled={createMutation.isPending} className="w-full py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50">
            {createMutation.isPending ? "Creating..." : "Create Task"}
          </button>
        </div>
      )}

      <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm overflow-hidden">
        <table className="w-full">
          <thead><tr className="border-b border-white/10">
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Name</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Schedule</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Pod</th>
            <th className="text-left px-4 py-3 text-xs font-semibold text-slate-400">Command</th>
            <th className="px-4 py-3 text-xs font-semibold text-slate-400">Enabled</th>
            <th className="px-4 py-3"></th>
          </tr></thead>
          <tbody>
            {tasks.map(t => (
              <tr key={t.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td className="px-4 py-3 text-sm text-white font-medium">{t.name}</td>
                <td className="px-4 py-3 text-sm text-slate-300 font-mono">{t.schedule}</td>
                <td className="px-4 py-3 text-sm text-slate-400">{t.namespace}/{t.pod}</td>
                <td className="px-4 py-3 text-sm text-slate-400 font-mono">{t.command}</td>
                <td className="px-4 py-3 text-center">
                  <button onClick={() => toggleMutation.mutate({ id: t.id, enabled: !t.enabled })} className={cn("w-8 h-4 rounded-full transition-colors relative", t.enabled ? "bg-indigo-500" : "bg-white/10")}>
                    <span className={cn("absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all", t.enabled ? "left-4.5 left-[calc(100%-14px)]" : "left-0.5")} />
                  </button>
                </td>
                <td className="px-4 py-3">
                  <button onClick={() => deleteMutation.mutate(t.id)} className="text-red-400 hover:text-red-300 transition-colors">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {tasks.length === 0 && <div className="py-12 text-center text-slate-500 text-sm">No scheduled tasks</div>}
      </div>
    </motion.div>
  );
}
