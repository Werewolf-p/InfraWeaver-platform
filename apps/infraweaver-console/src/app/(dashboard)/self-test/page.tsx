"use client";

import { useState } from "react";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  TestTube2,
  Server,
  Box,
  Cpu,
  Clock,
  ShieldCheck,
} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";

interface SelfTestResult {
  healthy: boolean;
  podCount?: number;
  appCount?: number;
  nodeCount?: number;
  testedAt?: string;
  error?: string;
}

interface StatCardProps {
  icon: React.ElementType;
  label: string;
  value: string | number;
  healthy?: boolean;
}

function StatCard({ icon: Icon, label, value, healthy }: StatCardProps) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-5">
      <div
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
          healthy === false
            ? "bg-destructive/10 text-destructive"
            : healthy === true
              ? "bg-green-500/10 text-green-500"
              : "bg-muted text-muted-foreground"
        )}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="text-lg font-semibold leading-tight text-foreground">{value}</p>
      </div>
    </div>
  );
}

export default function SelfTestPage() {
  const [result, setResult] = useState<SelfTestResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function runTest() {
    setLoading(true);
    try {
      const res = await fetch("/api/self-test");
      const data = (await res.json()) as SelfTestResult;
      setResult(data);
    } catch {
      setResult({ healthy: false, error: "Failed to reach /api/self-test" });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Self-Test"
        subtitle="Verify console service account connectivity to the Kubernetes API"
        icon={TestTube2}
      />

      {/* Run button */}
      <div className="flex items-center gap-3">
        <button
          onClick={runTest}
          disabled={loading}
          className={cn(
            "inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-medium transition-colors",
            "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          )}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <TestTube2 className="h-4 w-4" />
          )}
          {loading ? "Running…" : "Run Self-Test"}
        </button>

        {result && (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold",
              result.healthy
                ? "bg-green-500/10 text-green-600 dark:text-green-400"
                : "bg-destructive/10 text-destructive"
            )}
          >
            {result.healthy ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              <XCircle className="h-3.5 w-3.5" />
            )}
            {result.healthy ? "Healthy" : "Unhealthy"}
          </span>
        )}
      </div>

      {/* Results grid */}
      {result && (
        <div className="space-y-4">
          {result.error && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              <strong>Error:</strong> {result.error}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              icon={ShieldCheck}
              label="SA Token"
              value={result.error?.includes("No SA token") ? "Missing" : "Present"}
              healthy={!result.error?.includes("No SA token")}
            />
            <StatCard
              icon={Server}
              label="Nodes"
              value={result.nodeCount ?? "—"}
              healthy={result.healthy}
            />
            <StatCard
              icon={Box}
              label="Deployments"
              value={result.appCount ?? "—"}
              healthy={result.healthy}
            />
            <StatCard
              icon={Cpu}
              label="Pods"
              value={result.podCount ?? "—"}
              healthy={result.healthy}
            />
          </div>

          {result.testedAt && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              Tested at {new Date(result.testedAt).toLocaleString()}
            </div>
          )}
        </div>
      )}

      {/* Info box */}
      {!result && !loading && (
        <div className="rounded-xl border border-border bg-card/50 p-6 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">What this test does</p>
          <ul className="mt-2 space-y-1.5 list-disc list-inside">
            <li>Reads the SA token from <code>CONSOLE_SA_TOKEN</code> env var or the in-cluster service account mount</li>
            <li>Calls <code>/api/v1/pods</code>, <code>/api/v1/nodes</code>, and <code>/apis/apps/v1/deployments</code> on the Kubernetes API</li>
            <li>Returns live counts for pods, deployments, and nodes</li>
          </ul>
        </div>
      )}
    </div>
  );
}
