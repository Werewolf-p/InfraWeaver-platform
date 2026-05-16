"use client";
import { motion } from "framer-motion";
import { useState } from "react";
import { toast } from "@/lib/notify";
import { GitBranch, Layers} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";

export default function DeploymentComparePage() {
  const [ns1, setNs1] = useState("default");
  const [dep1, setDep1] = useState("");
  const [ns2, setNs2] = useState("default");
  const [dep2, setDep2] = useState("");
  const [result, setResult] = useState<{ dep1: unknown; dep2: unknown } | null>(null);
  const [loading, setLoading] = useState(false);

  const handleCompare = async () => {
    if (!dep1 || !dep2) { toast.error("Enter both deployment names"); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/cluster/deployment-diff?ns1=${ns1}&dep1=${dep1}&ns2=${ns2}&dep2=${dep2}`);
      const data = await res.json() as { dep1: unknown; dep2: unknown };
      setResult(data);
    } catch {
      toast.error("Compare failed");
    } finally {
      setLoading(false);
    }
  };

  const fmt = (val: unknown): string => JSON.stringify(val, null, 2);

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={Layers} title="Deployment Compare" />
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2"><GitBranch className="w-5 h-5 text-slate-400" />Deployment Comparison</h2>
        <p className="text-sm text-slate-400">Compare two deployments side-by-side</p>
      </div>
      <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4">
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white">Deployment A</h3>
            <input value={ns1} onChange={e => setNs1(e.target.value)} placeholder="Namespace" className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50" />
            <input value={dep1} onChange={e => setDep1(e.target.value)} placeholder="Deployment name" className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50" />
          </div>
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-white">Deployment B</h3>
            <input value={ns2} onChange={e => setNs2(e.target.value)} placeholder="Namespace" className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50" />
            <input value={dep2} onChange={e => setDep2(e.target.value)} placeholder="Deployment name" className="w-full px-3 py-2 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50" />
          </div>
        </div>
        <button onClick={handleCompare} disabled={loading} className="mt-4 w-full py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50">
          {loading ? "Comparing..." : "Compare"}
        </button>
      </div>
      {result && (
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4">
            <h3 className="text-xs font-semibold text-slate-400 mb-3">{ns1}/{dep1}</h3>
            <pre className="text-xs text-green-300 overflow-auto max-h-96">{fmt(result.dep1)}</pre>
          </div>
          <div className="bg-slate-900/60 border border-white/10 rounded-xl backdrop-blur-sm p-4">
            <h3 className="text-xs font-semibold text-slate-400 mb-3">{ns2}/{dep2}</h3>
            <pre className="text-xs text-blue-300 overflow-auto max-h-96">{fmt(result.dep2)}</pre>
          </div>
        </div>
      )}
    </motion.div>
  );
}
