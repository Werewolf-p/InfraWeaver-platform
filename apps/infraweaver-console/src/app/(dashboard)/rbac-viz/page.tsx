"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Shield } from "lucide-react";

interface Binding {
  name: string;
  namespace?: string;
  role: string;
  subjects: { kind: string; name: string; namespace?: string }[];
}

interface RbacData {
  serviceAccounts: { name: string; namespace: string }[];
  bindings: Binding[];
}

export default function RbacVizPage() {
  const [selected, setSelected] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["security", "rbac"],
    queryFn: async () => {
      const res = await fetch("/api/security/rbac");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<RbacData>;
    },
  });

  const sas = data?.serviceAccounts ?? [];
  const bindings = data?.bindings ?? [];
  const subjects = [...new Set(bindings.flatMap(b => b.subjects.map(s => s.name)))];
  const selectedBindings = selected ? bindings.filter(b => b.subjects.some(s => s.name === selected)) : [];

  if (isLoading) return <div className="space-y-4">{[...Array(4)].map((_, i) => <div key={i} className="h-16 rounded-xl bg-white/5 animate-pulse" />)}</div>;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2"><Shield className="w-5 h-5 text-slate-400" />RBAC Permission Visualizer</h2>
        <p className="text-sm text-slate-400">Browse role bindings by subject</p>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4">
          <h3 className="text-sm font-semibold text-white mb-3">Subjects ({subjects.length})</h3>
          <div className="space-y-1 max-h-96 overflow-y-auto">
            {subjects.map(s => (
              <button key={s} onClick={() => setSelected(s === selected ? null : s)} className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${s === selected ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30" : "text-slate-400 hover:text-white hover:bg-white/5"}`}>
                {s}
              </button>
            ))}
            {subjects.length === 0 && <p className="text-slate-500 text-sm">No subjects found</p>}
          </div>
          <div className="mt-4 pt-4 border-t border-white/10">
            <h4 className="text-xs font-semibold text-slate-400 mb-2">Service Accounts ({sas.length})</h4>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {sas.slice(0, 10).map(sa => (
                <div key={`${sa.namespace}/${sa.name}`} className="text-xs text-slate-500 px-2">{sa.namespace}/{sa.name}</div>
              ))}
            </div>
          </div>
        </div>
        <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4">
          <h3 className="text-sm font-semibold text-white mb-3">
            {selected ? `Bindings for "${selected}"` : "Select a subject"}
          </h3>
          {!selected && <p className="text-slate-500 text-sm">Click a subject to see their bindings</p>}
          <div className="space-y-2">
            {selectedBindings.map(b => (
              <div key={b.name} className="p-3 rounded-lg bg-white/5 border border-white/10">
                <p className="text-sm font-medium text-white">{b.name}</p>
                <p className="text-xs text-indigo-400 mt-0.5">Role: {b.role}</p>
                {b.namespace && <p className="text-xs text-slate-500 mt-0.5">Namespace: {b.namespace}</p>}
              </div>
            ))}
            {selected && selectedBindings.length === 0 && <p className="text-slate-500 text-sm">No bindings found</p>}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
