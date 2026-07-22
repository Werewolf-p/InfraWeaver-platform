"use client";
import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "@/lib/notify";
import { Loader2, Terminal } from "lucide-react";
import { PageScaffold } from "@/components/ui/page-scaffold";
import { CopyButton } from "@/components/ui/copy-button";
import { useApiQuery } from "@/hooks/use-api-query";
import { useRBAC } from "@/hooks/use-rbac";

interface Pod {
  name: string;
  namespace: string;
  containers: string[];
  status: string;
}

interface CommandResult {
  command: string;
  body: string;
  isError: boolean;
  at: number;
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
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
  const [output, setOutput] = useState<CommandResult[]>([]);
  const [loading, setLoading] = useState(false);
  const scrollAnchorRef = useRef<HTMLDivElement>(null);

  const { data: podsData } = useApiQuery<Pod[]>({
    queryKey: ["pods"],
    path: "/api/pods",
  });

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ block: "end" });
  }, [output.length, loading]);

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
      const body = [data.output, data.error].filter((part): part is string => Boolean(part)).join("\n");
      setOutput(prev => [...prev, { command, body: body || "(no output)", isError: Boolean(data.error), at: Date.now() }]);
    } catch (e) {
      setOutput(prev => [...prev, { command, body: String(e), isError: true, at: Date.now() }]);
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  };

  const handleCommandKeyDown = (event: React.KeyboardEvent<HTMLSelectElement>) => {
    if (event.key === "Enter" && !loading) {
      event.preventDefault();
      void handleExec();
    }
  };

  const copyAllText = output.map((entry) => `$ ${entry.command}\n${entry.body}`).join("\n\n");

  return (
    <PageScaffold icon={Terminal} title="Pod Shell" description="Run a preset, read-only diagnostic command inside a pod.">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
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
          <select value={command} onChange={e => setCommand(e.target.value)} onKeyDown={handleCommandKeyDown} className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white font-mono outline-none focus:border-indigo-500/50">
            {ALLOWED_COMMANDS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <p className="mt-1 text-xs text-slate-500">Press Enter to run the selected command.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleExec} disabled={loading || !canExecPods} className="flex-1 py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50">
            {loading ? "Running..." : "Execute"}
          </button>
          <button onClick={() => setOutput([])} className="px-4 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-slate-500 dark:text-slate-400 hover:text-gray-900 dark:hover:text-white transition-colors">Clear</button>
        </div>
      </div>
      <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-black/60 overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
          <span className="text-xs font-medium uppercase tracking-[0.18em] text-slate-500">Output</span>
          {output.length > 0 ? <CopyButton text={copyAllText} label="Copy all" /> : null}
        </div>
        <div className="max-h-[28rem] overflow-auto p-4 font-mono text-sm">
          {output.length === 0 && !loading && <span className="text-slate-600">Output will appear here...</span>}
          {output.map((entry, i) => (
            <div key={`${entry.at}-${i}`} className="group mb-3 last:mb-0">
              <div className="flex items-center gap-2">
                <span className="text-indigo-300">$ {entry.command}</span>
                <span className="text-[11px] text-slate-600">{formatClock(entry.at)}</span>
                <CopyButton text={entry.body} label="" className="ml-auto opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100" />
              </div>
              <pre className={`mt-1 whitespace-pre-wrap ${entry.isError ? "text-red-400" : "text-green-300"}`}>{entry.body}</pre>
            </div>
          ))}
          {loading && (
            <div className="flex items-center gap-2 text-slate-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              <span className="text-xs">Running <span className="text-indigo-300">{command}</span>…</span>
            </div>
          )}
          <div ref={scrollAnchorRef} />
        </div>
      </div>
      </motion.div>
    </PageScaffold>
  );
}
