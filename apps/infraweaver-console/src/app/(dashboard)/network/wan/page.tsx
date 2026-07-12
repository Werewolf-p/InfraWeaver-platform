"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ExternalLink, Gamepad2, Globe, RefreshCw, Shield, Trash2 } from "lucide-react";
import { AutoRefreshControl } from "@/components/ui/auto-refresh-control";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SkeletonTable } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { cn, timeAgo } from "@/lib/utils";
import { toast } from "@/lib/notify";
import { useApiMutation, useApiQuery } from "@/hooks/use-api-query";
import { useRBAC } from "@/hooks/use-rbac";

interface PortForwardRule {
  _id: string;
  name: string;
  enabled: boolean;
  proto: "tcp" | "udp" | "tcp_udp";
  dst_port: string;
  fwd: string;
  fwd_port: string;
  src?: string;
  log?: boolean;
}

interface DuplicateWanPort {
  port: number;
  names: string[];
}

interface PortForwardResponse {
  rules: PortForwardRule[];
  duplicates: string[];
  portDuplicates: DuplicateWanPort[];
  error?: string;
}

interface WanStatus {
  wanIp: string;
  isCgnat: boolean;
  up: boolean;
}

const PROTO_LABEL: Record<PortForwardRule["proto"], string> = {
  tcp: "TCP",
  udp: "UDP",
  tcp_udp: "TCP/UDP",
};

/** A game-hub-created rule is named `game-<server>`; link back to the server. */
function gameServerHref(ruleName: string): string | null {
  if (!ruleName.startsWith("game-")) return null;
  return `/game-hub/${encodeURIComponent(ruleName.slice("game-".length))}`;
}

export default function WanFirewallPage() {
  const { can } = useRBAC();
  const canWrite = can("infra:write");
  const [refreshInterval, setRefreshInterval] = useState(30000);
  const [search, setSearch] = useState("");
  const [ruleToDelete, setRuleToDelete] = useState<PortForwardRule | null>(null);

  const {
    data,
    isLoading,
    isFetching,
    dataUpdatedAt,
    refetch,
    error,
  } = useApiQuery<PortForwardResponse>({
    queryKey: ["udm", "portforward"],
    path: "/api/udm/portforward",
    request: { cache: "no-store" },
    refetchInterval: refreshInterval || false,
    staleTime: refreshInterval ? Math.max(refreshInterval - 5000, 0) : 0,
  });

  const { data: wan } = useApiQuery<WanStatus>({
    queryKey: ["udm", "wan"],
    path: "/api/udm/portforward?wan=true",
    request: { cache: "no-store" },
    staleTime: 60000,
  });

  const rules = useMemo(() => data?.rules ?? [], [data?.rules]);
  const duplicateNames = useMemo(() => new Set(data?.duplicates ?? []), [data?.duplicates]);
  const duplicatePorts = data?.portDuplicates ?? [];

  const filteredRules = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return rules;
    return rules.filter((rule) =>
      [rule.name, rule.dst_port, rule.fwd, rule.fwd_port, PROTO_LABEL[rule.proto] ?? rule.proto].some((value) =>
        String(value).toLowerCase().includes(query),
      ),
    );
  }, [rules, search]);

  const lastUpdated = dataUpdatedAt ? timeAgo(new Date(dataUpdatedAt)) : null;
  const notConfigured = error instanceof Error && /not configured/i.test(error.message);

  async function refresh() {
    try {
      await refetch();
      toast.success("Port-forward rules refreshed");
    } catch {
      toast.error("Unable to refresh port-forward rules");
    }
  }

  const deleteRuleMutation = useApiMutation<unknown, PortForwardRule>({
    path: (rule) => `/api/udm/portforward?name=${encodeURIComponent(rule.name)}`,
    method: "DELETE",
    successMessage: (_data, rule) => `Deleted ${rule.name}`,
    errorMessage: (mutationError) => mutationError.message || "Failed to delete rule",
    onSuccess: async () => {
      setRuleToDelete(null);
      await refetch();
    },
  });

  function deleteRule() {
    if (!ruleToDelete) return;
    if (!canWrite) {
      toast.error("You do not have permission to delete firewall rules");
      return;
    }
    deleteRuleMutation.mutate(ruleToDelete);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Shield}
        title="WAN Firewall"
        subtitle="Every UDM port-forward rule — WAN ports opened through the gateway to internal services."
        actions={
          <AutoRefreshControl interval={refreshInterval} onChange={setRefreshInterval} onRefreshNow={() => void refresh()} />
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
            <Globe className="h-4 w-4 text-cyan-600 dark:text-cyan-300" />
            WAN status
          </div>
          {wan ? (
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
              <StatusBadge status={wan.up ? "healthy" : "failed"} label={wan.up ? "Link up" : "Link down"} size="sm" />
              <span className="font-mono text-slate-800 dark:text-slate-200">{wan.wanIp || "—"}</span>
              {wan.isCgnat ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-700 dark:text-amber-200">
                  <AlertTriangle className="h-3 w-3" /> CGNAT — forwards may not reach the internet
                </span>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">WAN status unavailable.</p>
          )}
        </div>

        <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-gray-900 dark:text-white">{rules.length} port-forward rule{rules.length === 1 ? "" : "s"}</p>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Managed on the UDM gateway. Game servers open one automatically on create.</p>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
              {lastUpdated ? `Updated ${lastUpdated}` : "Waiting for first sync"}
            </div>
          </div>
        </div>
      </div>

      {duplicateNames.size > 0 || duplicatePorts.length > 0 ? (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" /> Integrity warnings
          </div>
          <ul className="mt-2 list-inside list-disc space-y-1">
            {duplicateNames.size > 0 ? <li>Duplicate rule names: {[...duplicateNames].join(", ")}</li> : null}
            {duplicatePorts.map((dup) => (
              <li key={dup.port}>
                WAN port {dup.port} is claimed by {dup.names.length} rules: {dup.names.join(", ")}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 p-4">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search rules by name, port, or target…"
            className="w-full min-w-[220px] rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 px-3 py-2 text-sm text-gray-900 dark:text-white outline-none transition focus:border-cyan-500/40 sm:w-auto"
          />
        </div>

        <div className="mt-4">
          {isLoading ? (
            <SkeletonTable rows={6} cols={6} />
          ) : notConfigured ? (
            <EmptyState
              icon={Shield}
              title="UDM connector not configured"
              description="Add the UDM gateway credentials in Settings → UDM Connector to see and manage WAN port-forward rules."
            />
          ) : error ? (
            <EmptyState icon={AlertTriangle} title="Failed to load rules" description={error instanceof Error ? error.message : "Unknown error"} />
          ) : filteredRules.length === 0 ? (
            <EmptyState icon={Shield} title="No port-forward rules" description="No WAN ports are currently forwarded through the gateway." />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 dark:border-white/10 text-left text-xs uppercase tracking-[0.2em] text-slate-500">
                    <th className="px-3 py-3">Name</th>
                    <th className="px-3 py-3">Proto</th>
                    <th className="px-3 py-3">WAN port</th>
                    <th className="px-3 py-3">Forwards to</th>
                    <th className="px-3 py-3">Source</th>
                    <th className="px-3 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRules.map((rule) => {
                    const gameHref = gameServerHref(rule.name);
                    const isDuplicate = duplicateNames.has(rule.name);
                    return (
                      <tr key={rule._id} className="border-b border-gray-200 dark:border-white/5 hover:bg-gray-100 dark:hover:bg-white/[0.02]">
                        <td className="px-3 py-3 align-top">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-gray-900 dark:text-white">{rule.name}</span>
                            {gameHref ? (
                              <Link href={gameHref} className="inline-flex items-center gap-1 rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-violet-700 dark:text-violet-200 hover:bg-violet-500/20">
                                <Gamepad2 className="h-3 w-3" /> Game
                              </Link>
                            ) : null}
                            {!rule.enabled ? (
                              <span className="inline-flex rounded-full border border-slate-500/20 bg-slate-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-slate-600 dark:text-slate-300">Disabled</span>
                            ) : null}
                            {isDuplicate ? (
                              <span className="inline-flex rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-amber-700 dark:text-amber-200">Duplicate</span>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-3 py-3 align-top">
                          <span className="inline-flex rounded-full border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 px-2 py-1 text-xs font-semibold text-slate-700 dark:text-slate-300">
                            {PROTO_LABEL[rule.proto] ?? rule.proto}
                          </span>
                        </td>
                        <td className="px-3 py-3 align-top">
                          <span className="font-mono text-slate-800 dark:text-slate-200">{rule.dst_port}</span>
                        </td>
                        <td className="px-3 py-3 align-top">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-sm text-slate-800 dark:text-slate-200">{rule.fwd}:{rule.fwd_port}</span>
                            <CopyButton text={`${rule.fwd}:${rule.fwd_port}`} className="px-2 py-1" />
                          </div>
                        </td>
                        <td className="px-3 py-3 align-top text-slate-600 dark:text-slate-400">{rule.src && rule.src !== "any" ? rule.src : "Any"}</td>
                        <td className="px-3 py-3 align-top">
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => canWrite && setRuleToDelete(rule)}
                              disabled={!canWrite}
                              className="rounded-lg border border-red-500/20 bg-red-500/10 p-2 text-red-600 dark:text-red-300 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                              title={`Delete ${rule.name}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 p-4">
        <p className="text-sm text-slate-500 dark:text-slate-400">Game server WAN ports open and close automatically with the server.</p>
        <Link href="/game-hub" className="inline-flex items-center gap-2 rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 transition hover:text-gray-900 dark:hover:text-white">
          <Gamepad2 className="h-4 w-4" /> Open Game Hub <ExternalLink className="h-3 w-3" />
        </Link>
      </div>

      <ConfirmDialog
        open={Boolean(ruleToDelete)}
        onCancel={() => setRuleToDelete(null)}
        onConfirm={deleteRule}
        title={`Delete ${ruleToDelete?.name ?? "rule"}?`}
        description={ruleToDelete ? `This closes WAN port ${ruleToDelete.dst_port} forwarding to ${ruleToDelete.fwd}:${ruleToDelete.fwd_port}.` : undefined}
        confirmText="Delete rule"
        danger
      />
    </div>
  );
}
