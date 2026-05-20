"use client";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "@/lib/notify";
import { Terminal } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { useRBAC } from "@/hooks/use-rbac";

interface Pod {
  name: string;
  namespace: string;
  containers: string[];
  status: string;
}

const ALLOWED_COMMANDS = ["ls", "cat /etc/os-release", "env", "ps", "df", "free", "uname -a", "id", "pwd", "date", "ls -la", "ls -l", "df -h", "free -h", "ps aux"];

export default function PodShellPage() {
  const { can } = useRBAC();
  const canExecPods = can("cluster:admin");
  const searchParams = useSearchParams();
  const [selectedNs, setSelectedNs] = useState(searchParams.get("namespace") ?? "default");
  const [selectedPod, setSelectedPod] = useState(searchParams.get("pod") ?? "");
  const [selectedContainer, setSelectedContainer] = useState(searchParams.get("container") ?? "");
  const [command, setCommand] = useState("ls");
  const [output, setOutput] = useState<{ text: string; isError: boolean }[]>([]);
  const [loading, setLoading] = useState(false);

  const { data: podsData } = useQuery({
    queryKey: ["pods"],
    queryFn: async () => {
      const res = await fetch("/api/pods");
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<Pod[]>;
    },
  });

  const pods = podsData ?? [];
  const namespaces = [...new Set(pods.map(p => p.namespace))];
  const nsPods = pods.filter(p => p.namespace === selectedNs);
  const selectedPodObj = nsPods.find(p => p.name === selectedPod);
  const activeContainer = selectedPodObj?.containers.includes(selectedContainer)
    ? selectedContainer
    : (selectedPodObj?.containers[0] ?? searchParams.get("container") ?? "");

  const handleExec = async () => {
    if (!selectedPod || !activeContainer || !command) { toast.error("Select pod, container and command"); return; }
    if (!canExecPods) { toast.error("You do not have permission to execute commands in pods"); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/pods/exec", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ namespace: selectedNs, pod: selectedPod, container: activeContainer, command }) });
      const data = await res.json() as { output?: string; error?: string | null };
      if (data.output) setOutput(prev => [...prev, { text: `$ ${command}\n${data.output}`, isError: false }]);
      if (data.error) setOutput(prev => [...prev, { text: data.error ?? "", isError: true }]);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={Terminal} title="Pod Shell" />
      <div>
        <h2 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2"><Terminal className="w-5 h-5 text-slate-500 dark:text-slate-400" />Pod Shell Access</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">Execute safe read-only commands in pods</p>
      </div>
      <div className="bg-slate-100 dark:bg-slate-900/60 border border-gray-200 dark:border-white/10 rounded-xl backdrop-blur-sm p-4 space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label className="text-xs text-slate-500 dark:text-slate-400 mb-1 block">Namespace</label>
            <select value={selectedNs} onChange={e => { setSelectedNs(e.target.value); setSelectedPod(""); setSelectedContainer(""); }} className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white outline-none focus:border-indigo-500/50">
              {namespaces.map(ns => <option key={ns} value={ns}>{ns}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-500 dark:text-slate-400 mb-1 block">Pod</label>
            <select value={selectedPod} onChange={e => { setSelectedPod(e.target.value); setSelectedContainer(""); }} className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white outline-none focus:border-indigo-500/50">
              <option value="">Select pod...</option>
              {nsPods.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-500 dark:text-slate-400 mb-1 block">Container</label>
            <select value={activeContainer} onChange={e => setSelectedContainer(e.target.value)} className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white outline-none focus:border-indigo-500/50">
              <option value="">Select container...</option>
              {(selectedPodObj?.containers ?? []).map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="text-xs text-slate-500 dark:text-slate-400 mb-1 block">Command (allowed only)</label>
          <select value={command} onChange={e => setCommand(e.target.value)} className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white font-mono outline-none focus:border-indigo-500/50">
            {ALLOWED_COMMANDS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="flex gap-2">
          <button onClick={handleExec} disabled={loading || !canExecPods} className="flex-1 py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50">
            {loading ? "Running..." : "Execute"}
          </button>
          <button onClick={() => setOutput([])} className="px-4 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white transition-colors">Clear</button>
        </div>
      </div>
      <div className="bg-black/60 border border-gray-200 dark:border-white/10 rounded-xl p-4 min-h-64 font-mono text-sm">
        {output.length === 0 && <span className="text-slate-600">Output will appear here...</span>}
        {output.map((o, i) => (
          <pre key={i} className={`mb-2 whitespace-pre-wrap ${o.isError ? "text-red-400" : "text-green-300"}`}>{o.text}</pre>
        ))}
      </div>
    </motion.div>
  );
}
