"use client";

import { AlertTriangle, CheckCircle2, Loader2, MinusCircle, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type TestRunStatus = "pending" | "running" | "pass" | "fail" | "warn" | "skip";

/** Shared result shape for both diagnostics suites (client smoke checks + server self-test). */
export interface TestResult {
  id: string;
  name: string;
  category: string;
  status: TestRunStatus;
  /** Static description of what the check verifies (client smoke checks). */
  description?: string;
  /** Outcome message returned by the check (server self-test). */
  message?: string;
  detail?: string;
  error?: string;
  durationMs?: number;
}

const BADGE_CLASSES: Partial<Record<TestRunStatus, string>> = {
  pass: "bg-green-500/10 text-green-600 dark:text-green-400",
  fail: "bg-destructive/10 text-destructive",
  warn: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400",
  skip: "bg-muted text-muted-foreground",
};

export function statusIcon(status: TestRunStatus) {
  switch (status) {
    case "pending": return <div className="w-4 h-4 rounded-full border-2 border-slate-200 dark:border-slate-700" />;
    case "running": return <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />;
    case "pass": return <CheckCircle2 className="w-4 h-4 text-green-500" />;
    case "fail": return <XCircle className="w-4 h-4 text-red-400" />;
    case "warn": return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
    case "skip": return <MinusCircle className="w-4 h-4 text-slate-500" />;
  }
}

function TestRow({ result }: { result: TestResult }) {
  const badge = BADGE_CLASSES[result.status];
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className="flex-none mt-0.5">{statusIcon(result.status)}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-slate-800 dark:text-slate-200">{result.name}</span>
          {badge && (
            <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide", badge)}>
              {result.status}
            </span>
          )}
          {result.durationMs !== undefined && result.durationMs > 0 && (
            <span className="text-xs text-slate-600 dark:text-slate-400 font-mono">{result.durationMs.toFixed(0)}ms</span>
          )}
        </div>
        {result.description && <p className="text-xs text-slate-500 mt-0.5">{result.description}</p>}
        {result.message && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{result.message}</p>}
        {result.detail && <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-mono">{result.detail}</p>}
        {result.error && <p className="text-xs text-red-400 mt-1 font-mono">{result.error}</p>}
      </div>
    </div>
  );
}

interface TestRunListProps {
  results: TestResult[];
  /** Group results into bordered per-category sections with a pass/fail header. */
  grouped?: boolean;
  className?: string;
}

export function TestRunList({ results, grouped, className }: TestRunListProps) {
  if (!grouped) {
    return (
      <div className={cn("divide-y divide-gray-200 dark:divide-white/5", className)}>
        {results.map(result => <TestRow key={result.id} result={result} />)}
      </div>
    );
  }
  const categories = [...new Set(results.map(r => r.category))];
  return (
    <div className={cn("space-y-6", className)}>
      {categories.map(cat => {
        const catResults = results.filter(r => r.category === cat);
        const failCount = catResults.filter(r => r.status === "fail").length;
        return (
          <div key={cat} className="rounded-xl border border-gray-200 dark:border-white/10 overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 dark:bg-white/[0.02] border-b border-gray-200 dark:border-white/5 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">{cat}</h2>
              <div className="flex gap-2">
                {failCount > 0 && <span className="text-xs text-red-400">{failCount} failed</span>}
                {catResults.length > 0 && catResults.every(r => r.status === "pass") && (
                  <span className="text-xs text-green-400">✓ All passed</span>
                )}
              </div>
            </div>
            <TestRunList results={catResults} />
          </div>
        );
      })}
    </div>
  );
}
