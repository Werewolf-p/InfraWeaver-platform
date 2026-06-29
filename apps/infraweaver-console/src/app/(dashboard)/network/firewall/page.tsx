"use client";

import { useCallback, useEffect, useState } from "react";

interface BlockedDestination {
  kind: "fqdn" | "ip" | "pod" | "unknown";
  target: string;
  namespace?: string;
  port?: string;
  protocol?: string;
  reason?: string;
  dropRate: number;
}
interface PodBlockedSummary {
  namespace: string;
  pod: string;
  destinations: BlockedDestination[];
  totalDropRate: number;
}
interface ApiResponse {
  available: boolean;
  dataplaneLive?: boolean;
  windowMinutes?: number;
  pods: PodBlockedSummary[];
  reason?: string;
  note?: string;
}

const KIND_LABEL: Record<BlockedDestination["kind"], string> = {
  fqdn: "Domain",
  ip: "IP",
  pod: "Pod",
  unknown: "Unknown",
};

export default function FirewallPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/network/blocked-flows?window=10", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as ApiResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Defer out of the effect body so we don't setState synchronously on mount.
    const t0 = setTimeout(load, 0);
    const t = setInterval(load, 15000);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [load]);

  const allow = useCallback(
    async (pod: PodBlockedSummary, dest: BlockedDestination) => {
      const id = `${pod.namespace}/${pod.pod}/${dest.target}/${dest.port ?? ""}`;
      setBusy(id);
      setToast(null);
      try {
        const res = await fetch("/api/network/blocked-flows", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ namespace: pod.namespace, pod: pod.pod, destination: dest }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setToast(`Allowed ${dest.target} for ${pod.namespace}/${pod.pod}`);
        load();
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Failed to allow");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const dataplaneLive = data?.dataplaneLive ?? false;

  return (
    <div className="p-6 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Firewall — recently blocked</h1>
          <p className="text-sm text-gray-500">
            Egress denied by network policy in the last {data?.windowMinutes ?? 10} minutes, per pod. Allow what a
            workload legitimately needs with one click.
          </p>
        </div>
        <button onClick={load} className="rounded-md border px-3 py-1.5 text-sm hover:bg-gray-50">
          Refresh
        </button>
      </header>

      {toast && (
        <div className="rounded-md bg-blue-50 border border-blue-200 px-4 py-2 text-sm text-blue-800">{toast}</div>
      )}

      {!dataplaneLive && (
        <div className="rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
          The Cilium + Hubble dataplane isn&apos;t live yet, so there are no enforced denies to show. Once the migration
          completes (see docs/CILIUM-HUBBLE-MIGRATION-RUNBOOK.md), blocked egress appears here automatically.
        </div>
      )}

      {loading && !data && <p className="text-sm text-gray-500">Loading…</p>}
      {error && <p className="text-sm text-red-600">Error: {error}</p>}

      {data && data.pods.length === 0 && dataplaneLive && (
        <div className="rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
          No blocked egress in the window. The void is holding — nothing is being denied that anything tried to do.
        </div>
      )}

      <div className="space-y-4">
        {data?.pods.map((pod) => (
          <section key={`${pod.namespace}/${pod.pod}`} className="rounded-lg border">
            <div className="flex items-center justify-between border-b bg-gray-50 px-4 py-2">
              <div className="font-medium">
                <span className="text-gray-500">{pod.namespace}</span> / {pod.pod}
              </div>
              <span className="text-xs text-gray-500">{pod.destinations.length} blocked destination(s)</span>
            </div>
            <ul className="divide-y">
              {pod.destinations.map((dest) => {
                const id = `${pod.namespace}/${pod.pod}/${dest.target}/${dest.port ?? ""}`;
                const allowable = dest.kind !== "unknown";
                return (
                  <li key={id} className="flex items-center justify-between gap-4 px-4 py-2 text-sm">
                    <div className="min-w-0">
                      <span className="inline-block w-16 shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                        {KIND_LABEL[dest.kind]}
                      </span>
                      <span className="ml-2 font-mono">{dest.target}</span>
                      {dest.port && (
                        <span className="ml-1 text-gray-500">
                          :{dest.port}/{dest.protocol ?? "?"}
                        </span>
                      )}
                      {dest.reason && <span className="ml-2 text-xs text-gray-400">({dest.reason})</span>}
                    </div>
                    <button
                      disabled={!allowable || busy === id}
                      onClick={() => allow(pod, dest)}
                      className="shrink-0 rounded-md border border-blue-300 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
                      title={allowable ? "Append an egress allow rule for this destination" : "Unknown destination cannot be auto-allowed"}
                    >
                      {busy === id ? "Allowing…" : "Allow next time"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
