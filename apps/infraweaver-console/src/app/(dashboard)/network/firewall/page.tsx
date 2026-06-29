"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, X, ChevronDown, ChevronRight, ArrowDownLeft, ArrowUpRight } from "lucide-react";

type Direction = "ingress" | "egress";

interface BlockedDestination {
  kind: "fqdn" | "ip" | "pod" | "unknown";
  target: string;
  namespace?: string;
  port?: string;
  protocol?: string;
  reason?: string;
  dropRate: number;
}
interface PodDenies {
  namespace: string;
  pod: string;
  egress: BlockedDestination[];
  ingress: BlockedDestination[];
  totalDropRate: number;
}
interface DeniesResponse {
  available: boolean;
  dataplaneLive?: boolean;
  windowMinutes?: number;
  pods: PodDenies[];
  reason?: string;
  note?: string;
}
interface AllowedRuleEntry {
  policyName: string;
  namespace: string;
  direction: Direction;
  index: number;
  peer: string;
  ports: string;
  managed: boolean;
}
interface RulesResponse {
  available: boolean;
  ingress: AllowedRuleEntry[];
  egress: AllowedRuleEntry[];
}

const KIND_LABEL: Record<BlockedDestination["kind"], string> = {
  fqdn: "Domain",
  ip: "IP",
  pod: "Pod",
  unknown: "Unknown",
};

function podKey(p: { namespace: string; pod: string }): string {
  return `${p.namespace}/${p.pod}`;
}

export default function FirewallPage() {
  const [data, setData] = useState<DeniesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [bothSides, setBothSides] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [rules, setRules] = useState<Record<string, RulesResponse | null>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/network/blocked-flows?window=10", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as DeniesResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t0 = setTimeout(load, 0);
    const t = setInterval(load, 15000);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [load]);

  const loadRules = useCallback(async (pod: PodDenies) => {
    const key = podKey(pod);
    try {
      const res = await fetch(
        `/api/network/pod-rules?namespace=${encodeURIComponent(pod.namespace)}&pod=${encodeURIComponent(pod.pod)}`,
        { cache: "no-store" },
      );
      const body = (await res.json()) as RulesResponse;
      setRules((r) => ({ ...r, [key]: body }));
    } catch {
      setRules((r) => ({ ...r, [key]: { available: false, ingress: [], egress: [] } }));
    }
  }, []);

  const toggleExpand = useCallback(
    (pod: PodDenies) => {
      const key = podKey(pod);
      const next = !expanded[key];
      setExpanded((e) => ({ ...e, [key]: next }));
      if (next && !rules[key]) loadRules(pod);
    },
    [expanded, rules, loadRules],
  );

  const allow = useCallback(
    async (pod: PodDenies, direction: Direction, peer: BlockedDestination) => {
      const id = `allow/${podKey(pod)}/${direction}/${peer.target}/${peer.port ?? ""}`;
      setBusy(id);
      setToast(null);
      try {
        const res = await fetch("/api/network/blocked-flows", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            namespace: pod.namespace,
            pod: pod.pod,
            direction,
            peer,
            bidirectional: bothSides,
          }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setToast(
          body.bothSides
            ? `Allowed ${peer.target} on both sides for ${podKey(pod)}`
            : `Allowed ${peer.target} (${direction}) for ${podKey(pod)}`,
        );
        if (expanded[podKey(pod)]) loadRules(pod);
        load();
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Failed to allow");
      } finally {
        setBusy(null);
      }
    },
    [bothSides, expanded, load, loadRules],
  );

  const removeRule = useCallback(
    async (pod: PodDenies, rule: AllowedRuleEntry) => {
      const id = `rm/${rule.policyName}/${rule.direction}/${rule.index}`;
      setBusy(id);
      setToast(null);
      try {
        const res = await fetch("/api/network/pod-rules", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            namespace: rule.namespace,
            policyName: rule.policyName,
            direction: rule.direction,
            index: rule.index,
          }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        setToast(body.deletedPolicy ? `Removed rule and emptied ${rule.policyName}` : `Removed rule from ${rule.policyName}`);
        loadRules(pod);
      } catch (e) {
        setToast(e instanceof Error ? e.message : "Failed to remove");
      } finally {
        setBusy(null);
      }
    },
    [loadRules],
  );

  const dataplaneLive = data?.dataplaneLive ?? false;

  return (
    <div className="p-6 space-y-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Pod network security</h1>
          <p className="text-sm text-gray-500">
            Traffic denied by network policy in the last {data?.windowMinutes ?? 10} minutes, per pod. Click the green
            check to allow a flow, or the red cross to remove an existing allow rule.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input type="checkbox" checked={bothSides} onChange={(e) => setBothSides(e.target.checked)} />
            Allow both sides for pod-to-pod
          </label>
          <button onClick={load} className="rounded-md border px-3 py-1.5 text-sm hover:bg-gray-50">
            Refresh
          </button>
        </div>
      </header>

      {toast && (
        <div className="rounded-md bg-blue-50 border border-blue-200 px-4 py-2 text-sm text-blue-800">{toast}</div>
      )}

      {!dataplaneLive && (
        <div className="rounded-md bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800">
          The Cilium + Hubble dataplane isn&apos;t reporting denies yet. Once it is live (see
          docs/CILIUM-HUBBLE-MIGRATION-RUNBOOK.md), blocked ingress and egress appear here automatically.
        </div>
      )}

      {loading && !data && <p className="text-sm text-gray-500">Loading…</p>}
      {error && <p className="text-sm text-red-600">Error: {error}</p>}

      {data && data.pods.length === 0 && dataplaneLive && (
        <div className="rounded-md bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
          No blocked traffic in the window. Nothing is being denied that anything tried to do.
        </div>
      )}

      <div className="space-y-4">
        {data?.pods.map((pod) => {
          const key = podKey(pod);
          const isOpen = expanded[key];
          const podRules = rules[key];
          return (
            <section key={key} className="rounded-lg border">
              <div className="flex items-center justify-between border-b bg-gray-50 px-4 py-2">
                <div className="font-medium">
                  <span className="text-gray-500">{pod.namespace}</span> / {pod.pod}
                </div>
                <span className="text-xs text-gray-500">
                  {pod.ingress.length} in · {pod.egress.length} out blocked
                </span>
              </div>

              <DenyList
                title="Blocked incoming (ingress)"
                icon={<ArrowDownLeft className="h-4 w-4 text-rose-500" />}
                direction="ingress"
                pod={pod}
                items={pod.ingress}
                busy={busy}
                onAllow={allow}
              />
              <DenyList
                title="Blocked outgoing (egress)"
                icon={<ArrowUpRight className="h-4 w-4 text-rose-500" />}
                direction="egress"
                pod={pod}
                items={pod.egress}
                busy={busy}
                onAllow={allow}
              />

              <div className="border-t">
                <button
                  onClick={() => toggleExpand(pod)}
                  className="flex w-full items-center gap-1 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
                >
                  {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  Currently allowed rules
                </button>
                {isOpen && (
                  <div className="px-4 pb-3">
                    {!podRules && <p className="text-xs text-gray-400">Loading rules…</p>}
                    {podRules && podRules.ingress.length === 0 && podRules.egress.length === 0 && (
                      <p className="text-xs text-gray-400">No explicit allow rules select this pod.</p>
                    )}
                    {podRules && (
                      <>
                        <AllowedList title="Ingress" items={podRules.ingress} busy={busy} onRemove={(r) => removeRule(pod, r)} />
                        <AllowedList title="Egress" items={podRules.egress} busy={busy} onRemove={(r) => removeRule(pod, r)} />
                      </>
                    )}
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

interface DenyListProps {
  title: string;
  icon: React.ReactNode;
  direction: Direction;
  pod: PodDenies;
  items: BlockedDestination[];
  busy: string | null;
  onAllow: (pod: PodDenies, direction: Direction, peer: BlockedDestination) => void;
}

function DenyList({ title, icon, direction, pod, items, busy, onAllow }: DenyListProps) {
  if (items.length === 0) return null;
  return (
    <div className="border-b last:border-b-0">
      <div className="flex items-center gap-1.5 px-4 pt-2 text-xs font-medium uppercase tracking-wide text-gray-500">
        {icon}
        {title}
      </div>
      <ul className="divide-y">
        {items.map((peer) => {
          const id = `allow/${podKey(pod)}/${direction}/${peer.target}/${peer.port ?? ""}`;
          const allowable = direction === "egress" ? peer.kind !== "unknown" : peer.kind === "ip" || peer.kind === "pod";
          const reason = allowable
            ? "Allow this flow"
            : direction === "ingress" && peer.kind === "fqdn"
              ? "Domain sources cannot be allowed on ingress"
              : "Unknown peer cannot be auto-allowed";
          return (
            <li key={id} className="flex items-center justify-between gap-4 px-4 py-2 text-sm">
              <div className="min-w-0">
                <span className="inline-block w-16 shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
                  {KIND_LABEL[peer.kind]}
                </span>
                <span className="ml-2 font-mono">{peer.target}</span>
                {peer.port && (
                  <span className="ml-1 text-gray-500">
                    :{peer.port}/{peer.protocol ?? "?"}
                  </span>
                )}
                {peer.reason && <span className="ml-2 text-xs text-gray-400">({peer.reason})</span>}
              </div>
              <button
                disabled={!allowable || busy === id}
                onClick={() => onAllow(pod, direction, peer)}
                title={reason}
                className="flex shrink-0 items-center gap-1 rounded-md border border-green-300 bg-green-50 px-3 py-1 text-xs font-medium text-green-700 hover:bg-green-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />
                {busy === id ? "Allowing…" : "Allow"}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface AllowedListProps {
  title: string;
  items: AllowedRuleEntry[];
  busy: string | null;
  onRemove: (rule: AllowedRuleEntry) => void;
}

function AllowedList({ title, items, busy, onRemove }: AllowedListProps) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-400">{title}</div>
      <ul className="mt-1 divide-y rounded-md border">
        {items.map((rule) => {
          const id = `rm/${rule.policyName}/${rule.direction}/${rule.index}`;
          return (
            <li key={id} className="flex items-center justify-between gap-4 px-3 py-1.5 text-sm">
              <div className="min-w-0">
                <span className="font-mono">{rule.peer}</span>
                <span className="ml-1 text-gray-500">· {rule.ports}</span>
                <span className="ml-2 text-xs text-gray-400">{rule.policyName}</span>
                {rule.managed && (
                  <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-600">console</span>
                )}
              </div>
              <button
                disabled={busy === id}
                onClick={() => onRemove(rule)}
                title="Remove this allow rule"
                className="flex shrink-0 items-center gap-1 rounded-md border border-rose-300 bg-rose-50 px-3 py-1 text-xs font-medium text-rose-700 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
                {busy === id ? "Removing…" : "Remove"}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
