"use client";
import { motion } from "framer-motion";
import { useState } from "react";
import { toast } from "@/lib/notify";
import { Activity, Plus, Trash2, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { StatusBadge, type StatusType } from "@/components/ui/status-badge";

interface Endpoint {
  id: string;
  url: string;
  name: string;
}

interface TestResult {
  status?: number;
  statusText?: string;
  latencyMs?: number;
  error?: string;
}

interface EndpointResult extends Endpoint {
  result?: TestResult;
  testing?: boolean;
}

function healthBadge(result?: TestResult): { status: StatusType; label: string } {
  if (!result) return { status: "unknown", label: "Not tested" };
  if (result.error) return { status: "failed", label: "Error" };
  if (result.status && result.status < 400) return { status: "healthy", label: String(result.status) };
  return { status: "failed", label: String(result.status ?? "Error") };
}

export function HealthTesterView() {
  // Seed with the console's own health endpoints instead of external httpbin
  // URLs, so the default checks stay inside the platform. Stored as relative
  // paths (stable across SSR/hydration) and resolved to an absolute URL at test
  // time, since the upstream tester fetches the target server-side.
  const [endpoints, setEndpoints] = useState<EndpointResult[]>([
    { id: "console-health", url: "/api/health", name: "Console Health" },
    { id: "cluster-health", url: "/api/health/cluster", name: "Cluster Health" },
  ]);
  const [newUrl, setNewUrl] = useState("");
  const [newName, setNewName] = useState("");
  const [testingAll, setTestingAll] = useState(false);

  const testEndpoint = async (ep: EndpointResult): Promise<TestResult> => {
    try {
      const targetUrl = ep.url.startsWith("http") ? ep.url : `${window.location.origin}${ep.url}`;
      const res = await fetch("/api/webhooks/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: targetUrl, method: "GET", headers: {} }),
      });
      return await res.json() as TestResult;
    } catch (e) {
      return { error: String(e) };
    }
  };

  const handleTestAll = async () => {
    setTestingAll(true);
    setEndpoints(prev => prev.map(ep => ({ ...ep, testing: true })));
    const results = await Promise.all(endpoints.map(ep => testEndpoint(ep)));
    setEndpoints(prev => prev.map((ep, i) => ({ ...ep, testing: false, result: results[i] })));
    setTestingAll(false);
    toast.success("All endpoints tested");
  };

  const handleTestOne = async (id: string) => {
    const ep = endpoints.find(e => e.id === id);
    if (!ep) return;
    setEndpoints(prev => prev.map(e => e.id === id ? { ...e, testing: true } : e));
    const result = await testEndpoint(ep);
    setEndpoints(prev => prev.map(e => e.id === id ? { ...e, testing: false, result } : e));
  };

  const addEndpoint = () => {
    if (!newUrl.startsWith("http")) { toast.error("Invalid URL"); return; }
    setEndpoints(prev => [...prev, { id: Date.now().toString(), url: newUrl, name: newName || newUrl }]);
    setNewUrl("");
    setNewName("");
  };

  const removeEndpoint = (id: string) => setEndpoints(prev => prev.filter(e => e.id !== id));

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader
        icon={Activity}
        title="Health Check Tester"
        subtitle="Test HTTP endpoints and check their health"
        actions={
          <button onClick={handleTestAll} disabled={testingAll || endpoints.length === 0} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-700 dark:text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50">
            <Play className="w-4 h-4" />{testingAll ? "Testing..." : "Test All"}
          </button>
        }
      />

      <div className="bg-slate-100 dark:bg-slate-900/60 border border-gray-200 dark:border-white/10 rounded-xl backdrop-blur-sm p-4">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Add Endpoint</h3>
        <div className="flex gap-2">
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Name (optional)" className="px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50 w-36" />
          <input value={newUrl} onChange={e => setNewUrl(e.target.value)} placeholder="https://..." className="flex-1 px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50" />
          <button onClick={addEndpoint} className="flex items-center gap-1 px-4 py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-700 dark:text-indigo-300 hover:bg-indigo-500/30 transition-colors">
            <Plus className="w-4 h-4" />Add
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {endpoints.map(ep => (
          <div key={ep.id} className={cn("bg-slate-100 dark:bg-slate-900/60 border rounded-xl backdrop-blur-sm p-4 flex items-center gap-4", ep.result?.error || (ep.result?.status && ep.result.status >= 400) ? "border-red-500/20" : ep.result?.status ? "border-green-500/20" : "border-gray-200 dark:border-white/10")}>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900 dark:text-white">{ep.name}</p>
              <p className="text-xs text-slate-500 truncate">{ep.url}</p>
              {ep.result && (
                <div className="flex items-center gap-3 mt-1.5">
                  {(() => {
                    const badge = healthBadge(ep.result);
                    return <StatusBadge status={badge.status} label={badge.label} size="sm" />;
                  })()}
                  {ep.result.latencyMs !== undefined && <span className="text-xs text-slate-500">{ep.result.latencyMs}ms</span>}
                  {ep.result.error && <span className="text-xs text-red-500 dark:text-red-400 truncate">{ep.result.error}</span>}
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <button onClick={() => handleTestOne(ep.id)} disabled={ep.testing} className="px-3 py-1.5 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-xs text-slate-700 dark:text-slate-300 hover:text-gray-900 dark:hover:text-white transition-colors disabled:opacity-50">
                {ep.testing ? "Testing..." : "Test"}
              </button>
              <button onClick={() => removeEndpoint(ep.id)} aria-label={`Remove ${ep.name}`} className="text-red-500 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300 transition-colors">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
        {endpoints.length === 0 && <div className="py-12 text-center text-slate-500 text-sm">No endpoints added</div>}
      </div>
    </motion.div>
  );
}
