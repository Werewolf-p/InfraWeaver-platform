"use client";
import { motion } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { BellOff, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { useRBAC } from "@/hooks/use-rbac";

interface Silence {
  id: string;
  name: string;
  matchers: string;
  startsAt: string;
  endsAt: string;
  comment: string;
  createdBy: string;
}

export default function AlertSilencePage() {
  const { can } = useRBAC();
  const canManageSilences = can("config:write");
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", matchers: "", comment: "", endsAt: new Date(Date.now() + 3600000).toISOString().slice(0, 16) });

  const { data, isLoading } = useQuery({
    queryKey: ["alert-silences"],
    queryFn: async () => {
      const res = await fetch("/api/alerts/silence");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ silences: Silence[] }>;
    },
  });

  const silences = data?.silences ?? [];

  const createMutation = useMutation({
    mutationFn: async (body: typeof form) => {
      if (!canManageSilences) throw new Error("Forbidden");
      const res = await fetch("/api/alerts/silence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, endsAt: new Date(body.endsAt).toISOString() }) });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => { toast.success("Silence created"); void qc.invalidateQueries({ queryKey: ["alert-silences"] }); setShowForm(false); },
    onError: () => toast.error("Failed to create silence"),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!canManageSilences) throw new Error("Forbidden");
      const res = await fetch(`/api/alerts/silence?id=${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed");
    },
    onSuccess: () => { toast.success("Silence removed"); void qc.invalidateQueries({ queryKey: ["alert-silences"] }); },
  });

  if (isLoading) return <div className="space-y-4">{[...Array(3)].map((_, i) => <div key={i} className="h-16 rounded-xl bg-white/5 animate-pulse" />)}</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={BellOff} title="Alert Silence" />
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2"><BellOff className="w-5 h-5 text-slate-400" />Alert Silencing</h2>
          <p className="text-sm text-slate-400">Manage alert silences and suppressions</p>
        </div>
        <button onClick={() => canManageSilences && setShowForm(v => !v)} disabled={!canManageSilences} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:cursor-not-allowed disabled:opacity-50">
          <Plus className="w-4 h-4" />New Silence
        </button>
      </div>

      {showForm && (
        <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4 space-y-3">
          <h3 className="text-sm font-semibold text-white">Create Silence</h3>
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Silence name" className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50" />
          <input value={form.matchers} onChange={e => setForm(f => ({ ...f, matchers: e.target.value }))} placeholder='Matchers e.g. alertname="HighCPU"' className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50" />
          <input value={form.comment} onChange={e => setForm(f => ({ ...f, comment: e.target.value }))} placeholder="Comment" className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50" />
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Ends At</label>
            <input type="datetime-local" value={form.endsAt} onChange={e => setForm(f => ({ ...f, endsAt: e.target.value }))} className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white outline-none focus:border-indigo-500/50" />
          </div>
          <button onClick={() => createMutation.mutate(form)} disabled={createMutation.isPending || !canManageSilences} className="w-full py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50">
            {createMutation.isPending ? "Creating..." : "Create"}
          </button>
        </div>
      )}

      <div className="space-y-3">
        {silences.length === 0 && <div className="py-12 text-center text-slate-500 text-sm">No active silences</div>}
        {silences.map(s => (
          <div key={s.id} className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4 flex items-start justify-between">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-white">{s.name}</p>
              <p className="text-xs text-slate-400">{s.matchers}</p>
              <p className="text-xs text-slate-500">Expires: {new Date(s.endsAt).toLocaleString()} · by {s.createdBy}</p>
              {s.comment && <p className="text-xs text-slate-500 italic">{s.comment}</p>}
            </div>
            <button onClick={() => deleteMutation.mutate(s.id)} disabled={!canManageSilences} className="text-red-400 hover:text-red-300 transition-colors flex-shrink-0 ml-4 disabled:opacity-50">
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
