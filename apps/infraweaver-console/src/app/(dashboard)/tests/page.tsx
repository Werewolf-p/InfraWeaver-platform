"use client";
import { useState, useCallback } from "react";
import { CheckCircle2, XCircle, Loader2, Play, Info, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

interface TestResult {
  id: string;
  name: string;
  category: string;
  description: string;
  status: "pending" | "running" | "pass" | "fail" | "skip";
  durationMs?: number;
  error?: string;
  detail?: string;
}

const TEST_DEFS: Omit<TestResult, "status" | "durationMs" | "error" | "detail">[] = [
  // Authentication
  { id: "api-auth", name: "Auth Session", category: "Authentication", description: "Verifies the current session is valid" },
  // Core APIs
  { id: "api-argocd", name: "ArgoCD API", category: "Core APIs", description: "ArgoCD apps endpoint returns data" },
  { id: "api-pods", name: "Pods API", category: "Core APIs", description: "Kubernetes pods endpoint returns data" },
  { id: "api-health-cluster", name: "Cluster Health", category: "Core APIs", description: "Cluster health check endpoint" },
  { id: "api-health", name: "Health/Gatus", category: "Core APIs", description: "Health endpoint (may return fallback data if Gatus unavailable)" },
  { id: "api-gameservers", name: "Port Routing API", category: "Core APIs", description: "Game servers endpoint returns data" },
  { id: "api-storage", name: "Storage API", category: "Core APIs", description: "PV storage endpoint returns data" },
  { id: "api-network", name: "Network Topology", category: "Core APIs", description: "Network topology endpoint" },
  { id: "api-community-apps", name: "Community Apps API", category: "Core APIs", description: "Community AppFeed endpoint (may be slow on first load)" },
  { id: "api-config-platform", name: "Platform Config", category: "Core APIs", description: "Platform config endpoint" },
  // Pages
  { id: "page-apps", name: "Applications Page", category: "Pages", description: "Apps page is accessible" },
  { id: "page-health", name: "Health Page", category: "Pages", description: "Health page is accessible" },
  { id: "page-security", name: "Security Page", category: "Pages", description: "Security page is accessible" },
  // Mobile layout
  { id: "mobile-viewport", name: "Mobile Viewport", category: "Mobile", description: "Check if running on mobile viewport (<768px)" },
  { id: "mobile-bottom-nav", name: "Bottom Nav Present", category: "Mobile", description: "Mobile bottom navigation is in the DOM" },
  { id: "mobile-no-horizontal-scroll", name: "No Horizontal Overflow", category: "Mobile", description: "Page body does not overflow horizontally" },
];

async function runTest(id: string): Promise<{ status: "pass" | "fail" | "skip"; durationMs: number; error?: string; detail?: string }> {
  const start = performance.now();
  try {
    switch (id) {
      case "api-auth": {
        const r = await fetch("/api/auth/me");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json() as { user?: { name?: string } };
        return { status: "pass", durationMs: performance.now() - start, detail: `Signed in as: ${d.user?.name ?? "unknown"}` };
      }
      case "api-argocd": {
        const r = await fetch("/api/argocd/apps");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json() as unknown[];
        return { status: "pass", durationMs: performance.now() - start, detail: `${Array.isArray(d) ? d.length : "?"} apps` };
      }
      case "api-pods": {
        const r = await fetch("/api/pods");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json() as unknown[];
        return { status: "pass", durationMs: performance.now() - start, detail: `${Array.isArray(d) ? d.length : "?"} pods` };
      }
      case "api-health-cluster": {
        const r = await fetch("/api/health/cluster");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json() as { status: string };
        return { status: "pass", durationMs: performance.now() - start, detail: `Cluster: ${d.status}` };
      }
      case "api-health": {
        const r = await fetch("/api/health");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { status: "pass", durationMs: performance.now() - start, detail: "Returns Gatus data or fallback" };
      }
      case "api-gameservers": {
        const r = await fetch("/api/gameservers");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json() as { servers?: unknown[] };
        return { status: "pass", durationMs: performance.now() - start, detail: `${d.servers?.length ?? 0} routes` };
      }
      case "api-storage": {
        const r = await fetch("/api/storage/pvs");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json() as unknown[];
        return { status: "pass", durationMs: performance.now() - start, detail: `${Array.isArray(d) ? d.length : "?"} volumes` };
      }
      case "api-network": {
        const r = await fetch("/api/network/topology");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { status: "pass", durationMs: performance.now() - start };
      }
      case "api-community-apps": {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          const r = await fetch("/api/community-apps?limit=5", { signal: controller.signal });
          clearTimeout(timeout);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const d = await r.json() as { apps?: unknown[]; total?: number };
          return { status: "pass", durationMs: performance.now() - start, detail: `Feed loaded — ${d.total ?? "?"} apps total` };
        } finally {
          clearTimeout(timeout);
        }
      }
      case "api-config-platform": {
        const r = await fetch("/api/config/platform");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { status: "pass", durationMs: performance.now() - start };
      }
      case "page-apps":
      case "page-health":
      case "page-security": {
        const paths: Record<string, string> = { "page-apps": "/apps", "page-health": "/health", "page-security": "/security" };
        const r = await fetch(paths[id]);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { status: "pass", durationMs: performance.now() - start, detail: `${r.status} OK` };
      }
      case "mobile-viewport": {
        const isMobile = window.innerWidth < 768;
        return { status: "skip", durationMs: 0, detail: `Viewport: ${window.innerWidth}x${window.innerHeight}px — ${isMobile ? "mobile" : "desktop"}` };
      }
      case "mobile-bottom-nav": {
        const nav = document.querySelector("nav.fixed.bottom-0");
        return { status: nav ? "pass" : "fail", durationMs: 0, detail: nav ? "Bottom nav found in DOM" : "Bottom nav not found (may be desktop view)" };
      }
      case "mobile-no-horizontal-scroll": {
        const body = document.body;
        const html = document.documentElement;
        const hasOverflow = body.scrollWidth > body.clientWidth || html.scrollWidth > html.clientWidth;
        return {
          status: hasOverflow ? "fail" : "pass",
          durationMs: 0,
          detail: hasOverflow
            ? `Overflow detected: body.scrollWidth=${body.scrollWidth}, clientWidth=${body.clientWidth}`
            : "No horizontal overflow",
        };
      }
      default:
        return { status: "skip", durationMs: 0, detail: "Not implemented" };
    }
  } catch (e) {
    return { status: "fail", durationMs: performance.now() - start, error: String(e) };
  }
}

export default function TestsPage() {
  const [results, setResults] = useState<TestResult[]>(
    TEST_DEFS.map(t => ({ ...t, status: "pending" }))
  );
  const [running, setRunning] = useState(false);
  const [startTime, setStartTime] = useState<number | null>(null);

  const runAll = useCallback(async () => {
    setRunning(true);
    setStartTime(Date.now());
    setResults(TEST_DEFS.map(t => ({ ...t, status: "pending" })));
    for (const def of TEST_DEFS) {
      setResults(prev => prev.map(r => r.id === def.id ? { ...r, status: "running" } : r));
      const result = await runTest(def.id);
      setResults(prev => prev.map(r => r.id === def.id ? { ...r, ...result } : r));
    }
    setRunning(false);
  }, []);

  const categories = [...new Set(TEST_DEFS.map(t => t.category))];
  const passed = results.filter(r => r.status === "pass").length;
  const failed = results.filter(r => r.status === "fail").length;
  const skipped = results.filter(r => r.status === "skip").length;
  const total = results.filter(r => r.status !== "pending").length;
  const duration = startTime && !running ? ((Date.now() - startTime) / 1000).toFixed(1) : null;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Platform Tests</h1>
          <p className="text-sm text-slate-400 mt-1">Interactive test suite for APIs, pages, and mobile layout</p>
        </div>
        <button
          onClick={runAll}
          disabled={running}
          className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {running
            ? <><Loader2 className="w-4 h-4 animate-spin" /> Running...</>
            : <><Play className="w-4 h-4" /> Run All Tests</>
          }
        </button>
      </div>

      {/* Summary */}
      {total > 0 && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "Passed", value: passed, color: "text-green-400", bg: "bg-green-500/10 border-green-500/20" },
            { label: "Failed", value: failed, color: "text-red-400", bg: "bg-red-500/10 border-red-500/20" },
            { label: "Skipped", value: skipped, color: "text-slate-400", bg: "bg-slate-800 border-white/10" },
          ].map(s => (
            <div key={s.label} className={cn("p-4 rounded-xl border", s.bg)}>
              <div className={cn("text-2xl font-bold", s.color)}>{s.value}</div>
              <div className="text-xs text-slate-500 mt-0.5">
                {s.label}{duration && s.label === "Passed" && <span className="text-slate-600"> ({duration}s)</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Results by category */}
      {categories.map(cat => {
        const catResults = results.filter(r => r.category === cat);
        return (
          <div key={cat} className="rounded-xl border border-white/10 overflow-hidden">
            <div className="px-4 py-3 bg-white/[0.02] border-b border-white/5 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-300">{cat}</h2>
              <div className="flex gap-2">
                {catResults.some(r => r.status === "fail") && (
                  <span className="text-xs text-red-400">{catResults.filter(r => r.status === "fail").length} failed</span>
                )}
                {catResults.length > 0 && catResults.every(r => r.status === "pass") && (
                  <span className="text-xs text-green-400">✓ All passed</span>
                )}
              </div>
            </div>
            <div className="divide-y divide-white/5">
              {catResults.map(result => (
                <div key={result.id} className="flex items-start gap-3 px-4 py-3">
                  <div className="flex-none mt-0.5">
                    {result.status === "pending" && <div className="w-4 h-4 rounded-full border-2 border-slate-700" />}
                    {result.status === "running" && <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />}
                    {result.status === "pass" && <CheckCircle2 className="w-4 h-4 text-green-400" />}
                    {result.status === "fail" && <XCircle className="w-4 h-4 text-red-400" />}
                    {result.status === "skip" && <Info className="w-4 h-4 text-slate-500" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-slate-200">{result.name}</span>
                      {result.durationMs !== undefined && result.durationMs > 0 && (
                        <span className="text-xs text-slate-600 font-mono">{result.durationMs.toFixed(0)}ms</span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">{result.description}</p>
                    {result.detail && <p className="text-xs text-slate-400 mt-1 font-mono">{result.detail}</p>}
                    {result.error && <p className="text-xs text-red-400 mt-1 font-mono">{result.error}</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {/* Info */}
      <div className="flex items-start gap-3 p-4 rounded-xl bg-blue-500/5 border border-blue-500/20">
        <AlertTriangle className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
        <div className="text-xs text-slate-400 space-y-1">
          <p>Tests run directly in your browser against the platform APIs. Some tests may fail if optional components (Gatus, community app feed) are unavailable.</p>
          <p>Mobile tests are informational — run on your phone to check mobile-specific behavior.</p>
        </div>
      </div>
    </div>
  );
}
