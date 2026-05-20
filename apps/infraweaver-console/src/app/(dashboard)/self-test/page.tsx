"use client";

import { useState } from "react";
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  MinusCircle,
  Loader2,
  TestTube2,
  Server,
  Shield,
  Gamepad2,
  GitBranch,
  Activity,
  Award,
  Clock,
  ChevronDown,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";

interface TestResult {
  id: string;
  name: string;
  category: string;
  status: "pass" | "fail" | "warn" | "skip";
  message: string;
  detail?: string;
  durationMs: number;
}

interface TestSuiteResponse {
  results: TestResult[];
  summary: { total: number; pass: number; fail: number; warn: number; skip: number };
  testedAt: string;
}

const CATEGORIES: Array<{ id: string; label: string; icon: React.ElementType; description: string }> = [
  { id: "security", label: "Security", icon: Shield, description: "Rate limiter, Zod validation, auth enforcement, CSRF, security headers, secret env vars" },
  { id: "stability", label: "Stability", icon: Activity, description: "Middleware crash recovery, circuit breaker, error boundaries, PDB, chunk reload on deploy" },
  { id: "features", label: "Features", icon: Award, description: "User preferences, keyboard shortcuts, ConfirmDialog, design tokens, TanStack Table, skeletons" },
  { id: "kubernetes", label: "Kubernetes", icon: Server, description: "API connectivity, nodes, namespaces, storage" },
  { id: "console", label: "Console", icon: Shield, description: "Pod health, service account, ingress" },
  { id: "game-hub", label: "Game Hub", icon: Gamepad2, description: "Namespace, RBAC, quota, storage class" },
  { id: "argocd", label: "ArgoCD", icon: GitBranch, description: "GitOps API and application sync status" },
  { id: "monitoring", label: "Monitoring", icon: Activity, description: "Prometheus, alerting, metrics collection" },
  { id: "certificates", label: "Certificates", icon: Award, description: "cert-manager, TLS certificates" },
];

function statusIcon(status: TestResult["status"]) {
  switch (status) {
    case "pass": return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case "fail": return <XCircle className="h-4 w-4 text-destructive" />;
    case "warn": return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
    case "skip": return <MinusCircle className="h-4 w-4 text-muted-foreground" />;
  }
}

function statusBadge(status: TestResult["status"]) {
  const map = {
    pass: "bg-green-500/10 text-green-600 dark:text-green-400",
    fail: "bg-destructive/10 text-destructive",
    warn: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
    skip: "bg-muted text-muted-foreground",
  };
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide", map[status])}>
      {status}
    </span>
  );
}

function SummaryBar({ summary }: { summary: TestSuiteResponse["summary"] }) {
  const { total, pass, fail, warn, skip } = summary;
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span className="font-medium text-foreground">{total} tests</span>
      {pass > 0 && <span className="text-green-600 dark:text-green-400 font-medium">✓ {pass} passed</span>}
      {fail > 0 && <span className="text-destructive font-medium">✗ {fail} failed</span>}
      {warn > 0 && <span className="text-yellow-600 dark:text-yellow-400 font-medium">⚠ {warn} warnings</span>}
      {skip > 0 && <span className="text-muted-foreground">– {skip} skipped</span>}
    </div>
  );
}

function CategoryCard({
  category,
  results,
  running,
  onRun,
}: {
  category: typeof CATEGORIES[number];
  results: TestResult[];
  running: boolean;
  onRun: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon = category.icon;
  const pass = results.filter(r => r.status === "pass").length;
  const fail = results.filter(r => r.status === "fail").length;
  const warn = results.filter(r => r.status === "warn").length;

  const overallStatus = results.length === 0
    ? "idle"
    : fail > 0 ? "fail" : warn > 0 ? "warn" : "pass";

  const borderClass =
    overallStatus === "fail" ? "border-destructive/40" :
    overallStatus === "warn" ? "border-yellow-500/40" :
    overallStatus === "pass" ? "border-green-500/30" :
    "border-border";

  return (
    <div className={cn("rounded-xl border bg-card transition-colors", borderClass)}>
      <div className="flex items-center gap-4 p-4">
        <div className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
          overallStatus === "fail" ? "bg-destructive/10 text-destructive" :
          overallStatus === "warn" ? "bg-yellow-500/10 text-yellow-500" :
          overallStatus === "pass" ? "bg-green-500/10 text-green-500" :
          "bg-muted text-muted-foreground"
        )}>
          <Icon className="h-5 w-5" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-foreground">{category.label}</p>
            {results.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {pass}/{results.length} passed
                {fail > 0 && `, ${fail} failed`}
                {warn > 0 && `, ${warn} warned`}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{category.description}</p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={onRun}
            disabled={running}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
              "border border-border bg-background hover:bg-muted disabled:opacity-50"
            )}
          >
            {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            {running ? "Running…" : "Run"}
          </button>
          {results.length > 0 && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              {expanded ? "Hide" : "Details"}
            </button>
          )}
        </div>
      </div>

      {expanded && results.length > 0 && (
        <div className="border-t border-border divide-y divide-border">
          {results.map(r => (
            <div key={r.id} className="flex items-start gap-3 px-4 py-3">
              <div className="mt-0.5 shrink-0">{statusIcon(r.status)}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-foreground">{r.name}</span>
                  {statusBadge(r.status)}
                  <span className="text-xs text-muted-foreground">{r.durationMs}ms</span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">{r.message}</p>
                {r.detail && (
                  <p className="text-xs text-muted-foreground/70 mt-0.5 font-mono">{r.detail}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function SelfTestPage() {
  const [results, setResults] = useState<TestResult[]>([]);
  const [running, setRunning] = useState<string | null>(null); // "all" or category id
  const [testedAt, setTestedAt] = useState<string | null>(null);
  const [summary, setSummary] = useState<TestSuiteResponse["summary"] | null>(null);

  async function runCategory(category?: string) {
    const key = category ?? "all";
    setRunning(key);
    try {
      const url = category ? `/api/test-suite?category=${category}` : "/api/test-suite";
      const res = await fetch(url);
      const data = (await res.json()) as TestSuiteResponse;
      setResults(prev => {
        if (!category) return data.results;
        const kept = prev.filter(r => r.category !== category);
        return [...kept, ...data.results];
      });
      if (!category) setSummary(data.summary);
      setTestedAt(data.testedAt);
    } catch {
      // ignore
    } finally {
      setRunning(null);
    }
  }

  const allFail = results.filter(r => r.status === "fail").length;
  const allPass = results.filter(r => r.status === "pass").length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Interactive Test Suite"
        subtitle="Run live diagnostics across Kubernetes, Game Hub, ArgoCD, monitoring, and certificates"
        icon={TestTube2}
      />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => runCategory()}
          disabled={running !== null}
          className={cn(
            "inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-colors",
            "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          )}
        >
          {running === "all" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <TestTube2 className="h-4 w-4" />
          )}
          {running === "all" ? "Running all tests…" : "Run All Tests"}
        </button>

        {summary && (
          <div className="flex items-center gap-2">
            <span className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold",
              allFail > 0 ? "bg-destructive/10 text-destructive" :
              summary.warn > 0 ? "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400" :
              "bg-green-500/10 text-green-600 dark:text-green-400"
            )}>
              {allFail > 0 ? <XCircle className="h-3.5 w-3.5" /> :
               summary.warn > 0 ? <AlertTriangle className="h-3.5 w-3.5" /> :
               <CheckCircle2 className="h-3.5 w-3.5" />}
              {allFail > 0 ? `${allFail} failure(s)` : summary.warn > 0 ? `${summary.warn} warning(s)` : `All ${allPass} passed`}
            </span>
            <SummaryBar summary={summary} />
          </div>
        )}

        {testedAt && (
          <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            {new Date(testedAt).toLocaleTimeString()}
          </div>
        )}
      </div>

      {/* Category cards */}
      <div className="grid gap-4 lg:grid-cols-3">
        {CATEGORIES.map(cat => (
          <CategoryCard
            key={cat.id}
            category={cat}
            results={results.filter(r => r.category === cat.id)}
            running={running === cat.id || running === "all"}
            onRun={() => runCategory(cat.id)}
          />
        ))}
      </div>

      {/* Legend */}
      {results.length === 0 && running === null && (
        <div className="rounded-xl border border-border bg-card/50 p-6">
          <p className="text-sm font-medium text-foreground mb-3">Test categories</p>
          <div className="grid gap-2 sm:grid-cols-2 text-xs text-muted-foreground">
            {CATEGORIES.map(cat => (
              <div key={cat.id} className="flex items-start gap-2">
                <cat.icon className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span><strong className="text-foreground">{cat.label}:</strong> {cat.description}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap gap-4 text-xs text-muted-foreground border-t border-border pt-4">
            <div className="flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> Pass — check succeeded</div>
            <div className="flex items-center gap-1.5"><XCircle className="h-3.5 w-3.5 text-destructive" /> Fail — check failed, action needed</div>
            <div className="flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5 text-yellow-500" /> Warn — degraded or missing optional component</div>
            <div className="flex items-center gap-1.5"><MinusCircle className="h-3.5 w-3.5 text-muted-foreground" /> Skip — not applicable in this environment</div>
          </div>
        </div>
      )}
    </div>
  );
}
