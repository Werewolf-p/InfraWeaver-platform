"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ExternalLink,
  Gamepad2,
  Globe,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Shield,
  Trash2,
} from "lucide-react";
import {
  DnsRecordDialog,
  type DnsRecordDefaults,
} from "@/components/dns/dns-record-dialog";
import { AutoRefreshControl } from "@/components/ui/auto-refresh-control";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { SkeletonTable } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  INTERNAL_DNS_DOMAIN,
  ROOT_DNS_DOMAIN,
  type ManagedDnsRecord,
} from "@/lib/dns";
import { cn, timeAgo } from "@/lib/utils";
import { toast } from "sonner";

interface DnsResponse {
  records: ManagedDnsRecord[];
}

interface GameHubServersResponse {
  servers: Array<{
    name: string;
    nodeIp?: string | null;
    dnsHostname?: string;
    description?: string;
  }>;
}

const TAB_STORAGE_KEY = "infraweaver:dns-tab";
const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

type DnsTab = "internal" | "public";

export default function DnsManagementPage() {
  const [tab, setTab] = useState<DnsTab>(() => {
    if (typeof window === "undefined") return "internal";
    const stored = window.localStorage.getItem(TAB_STORAGE_KEY);
    return stored === "public" ? "public" : "internal";
  });
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [refreshInterval, setRefreshInterval] = useState(30000);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogDefaults, setDialogDefaults] = useState<DnsRecordDefaults>({});
  const [editingRecord, setEditingRecord] = useState<ManagedDnsRecord | null>(null);
  const [recordToDelete, setRecordToDelete] = useState<ManagedDnsRecord | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(TAB_STORAGE_KEY, tab);
  }, [tab]);

  const {
    data,
    isLoading,
    isFetching,
    dataUpdatedAt,
    refetch,
  } = useQuery({
    queryKey: ["dns", "records"],
    queryFn: async () => {
      const res = await fetch("/api/dns", { cache: "no-store" });
      const payload = await res.json() as DnsResponse & { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Failed to load DNS records");
      return payload;
    },
    refetchInterval: refreshInterval || false,
    staleTime: refreshInterval ? Math.max(refreshInterval - 5000, 0) : 0,
  });

  const { data: gameHubData } = useQuery({
    queryKey: ["game-hub", "servers", "dns"],
    queryFn: async () => {
      const res = await fetch("/api/game-hub/servers", { cache: "no-store" });
      if (!res.ok) return { servers: [] } satisfies GameHubServersResponse;
      return res.json() as Promise<GameHubServersResponse>;
    },
    staleTime: 60000,
  });

  const records = data?.records ?? [];
  const filteredRecords = useMemo(() => {
    const scoped = records.filter((record) => (tab === "internal" ? record.internal : !record.internal));
    const query = search.trim().toLowerCase();
    if (!query) return scoped;
    return scoped.filter((record) =>
      [record.name, record.shortName, record.value, record.type].some((value) => value.toLowerCase().includes(query)),
    );
  }, [records, search, tab]);

  const totalPages = Math.max(1, Math.ceil(filteredRecords.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pagedRecords = filteredRecords.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const lastUpdated = dataUpdatedAt ? timeAgo(new Date(dataUpdatedAt)) : null;
  const machineTargets = useMemo(() => {
    const seen = new Set<string>();
    return (gameHubData?.servers ?? [])
      .map((server) => server.nodeIp?.trim())
      .filter((value): value is string => Boolean(value))
      .filter((value) => {
        if (seen.has(value)) return false;
        seen.add(value);
        return true;
      })
      .slice(0, 6)
      .map((value) => ({
        label: value,
        value,
        description: `Detected node IP ${value}`,
      }));
  }, [gameHubData?.servers]);

  const gameServerTargets = useMemo(() => {
    return (gameHubData?.servers ?? [])
      .filter((server) => server.nodeIp)
      .slice(0, 6)
      .map((server) => ({
        label: server.name,
        value: server.nodeIp ?? "",
        name: server.name,
        description: server.description,
        href: `/game-hub/${encodeURIComponent(server.name)}`,
      }));
  }, [gameHubData?.servers]);

  async function refreshRecords() {
    try {
      await refetch();
      toast.success("DNS records refreshed");
    } catch {
      toast.error("Unable to refresh DNS records");
    }
  }

  async function deleteRecord() {
    if (!recordToDelete) return;
    try {
      const res = await fetch(`/api/dns/${recordToDelete.id}`, { method: "DELETE" });
      const payload = await res.json() as { error?: string };
      if (!res.ok) throw new Error(payload.error ?? "Failed to delete DNS record");
      toast.success(`Deleted ${recordToDelete.name}`);
      setRecordToDelete(null);
      await refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete DNS record");
    }
  }

  function exportCsv() {
    const rows = [
      ["name", "scope", "type", "value", "ttl", "updated_at"],
      ...filteredRecords.map((record) => [
        record.name,
        record.internal ? "internal" : "public",
        record.type,
        record.value,
        String(record.ttl),
        record.updatedAt ?? record.createdAt ?? "",
      ]),
    ];
    const csv = rows.map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `dns-${tab}-records.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Globe}
        title="DNS Management"
        subtitle="Manage internal VPN hostnames and public Cloudflare DNS from one place."
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <AutoRefreshControl
              interval={refreshInterval}
              onChange={setRefreshInterval}
              onRefreshNow={() => void refreshRecords()}
            />
            <button
              onClick={exportCsv}
              className="rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-sm text-slate-300 transition hover:text-white"
            >
              Export CSV
            </button>
            <button
              onClick={() => {
                setEditingRecord(null);
                setDialogDefaults({ internal: tab === "internal", type: "A" });
                setDialogOpen(true);
              }}
              className="inline-flex items-center gap-2 rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-sm font-medium text-cyan-200 transition hover:bg-cyan-500/20"
            >
              <Plus className="h-4 w-4" />
              Add Record
            </button>
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-white">Managed zones</p>
              <p className="mt-1 text-sm text-slate-400">
                Internal records target <span className="font-mono text-cyan-200">*.{INTERNAL_DNS_DOMAIN}</span> and public records target <span className="font-mono text-emerald-200">*.{ROOT_DNS_DOMAIN}</span>.
              </p>
            </div>
            <div className="text-right text-xs text-slate-500">
              <div className="flex items-center justify-end gap-2">
                <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
                {lastUpdated ? `Updated ${lastUpdated}` : "Waiting for first sync"}
              </div>
              <Link href="/game-hub" className="mt-1 inline-flex items-center gap-1.5 text-cyan-200 hover:text-white">
                Add DNS for a game server
                <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Server className="h-4 w-4 text-cyan-300" />
            Quick templates
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {machineTargets.map((target) => (
              <button
                key={target.value}
                onClick={() => {
                  setEditingRecord(null);
                  setDialogDefaults({ value: target.value, type: "A", internal: true });
                  setDialogOpen(true);
                }}
                className="rounded-xl border border-cyan-500/20 bg-cyan-500/5 px-3 py-2 text-left text-xs text-cyan-100 transition hover:bg-cyan-500/10"
                title={target.description}
              >
                <div className="font-medium">Detected node</div>
                <div className="font-mono">{target.value}</div>
              </button>
            ))}
            {machineTargets.length === 0 ? <span className="text-xs text-slate-500">Node IPs appear here after game servers report in.</span> : null}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => {
                setTab("internal");
                setPage(1);
              }}
              className={cn(
                "inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition",
                tab === "internal"
                  ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-200"
                  : "border-white/10 bg-slate-950 text-slate-400 hover:text-white",
              )}
            >
              <Shield className="h-4 w-4" />
              Internal (VPN)
              <span className="rounded-full bg-black/20 px-2 py-0.5 text-xs">{records.filter((record) => record.internal).length}</span>
            </button>
            <button
              onClick={() => {
                setTab("public");
                setPage(1);
              }}
              className={cn(
                "inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm transition",
                tab === "public"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                  : "border-white/10 bg-slate-950 text-slate-400 hover:text-white",
              )}
            >
              <Globe className="h-4 w-4" />
              Public
              <span className="rounded-full bg-black/20 px-2 py-0.5 text-xs">{records.filter((record) => !record.internal).length}</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder={`Search ${tab} DNS records…`}
              className="w-full min-w-[220px] rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-500/40 sm:w-auto"
            />
            <select
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
              className="rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none"
              title="Rows per page"
            >
              {PAGE_SIZE_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}/page</option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-4">
          {isLoading ? (
            <SkeletonTable rows={6} cols={7} />
          ) : filteredRecords.length === 0 ? (
            <EmptyState
              icon={tab === "internal" ? Shield : Globe}
              title={tab === "internal" ? "No internal DNS records yet" : "No public DNS records yet"}
              description={tab === "internal"
                ? "Create VPN-only hostnames for machines, services, and game servers."
                : "Create public hostnames that resolve through Cloudflare."}
              action={{
                label: "Add first record",
                onClick: () => {
                  setEditingRecord(null);
                  setDialogDefaults({ internal: tab === "internal", type: "A" });
                  setDialogOpen(true);
                },
              }}
            />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/10 text-left text-xs uppercase tracking-[0.2em] text-slate-500">
                      <th className="px-3 py-3">Name</th>
                      <th className="px-3 py-3">Scope</th>
                      <th className="px-3 py-3">Type</th>
                      <th className="px-3 py-3">Value</th>
                      <th className="px-3 py-3">TTL</th>
                      <th className="px-3 py-3">Updated</th>
                      <th className="px-3 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRecords.map((record) => (
                      <tr key={record.id} className="border-b border-white/5 hover:bg-white/[0.02]">
                        <td className="px-3 py-3 align-top">
                          <div className="flex items-start gap-2">
                            <div className="min-w-0">
                              <div className="truncate font-medium text-white" title={record.name}>{record.name}</div>
                              <div className="mt-1 text-xs text-slate-500">Subdomain: {record.shortName}</div>
                            </div>
                            <CopyButton text={record.name} className="px-2 py-1" />
                          </div>
                        </td>
                        <td className="px-3 py-3 align-top">
                          <StatusBadge
                            status={record.internal ? "healthy" : "online"}
                            label={record.internal ? "Internal" : "Public"}
                            size="sm"
                          />
                        </td>
                        <td className="px-3 py-3 align-top">
                          <span className="inline-flex rounded-full border border-white/10 bg-slate-950 px-2 py-1 text-xs font-semibold text-slate-300">
                            {record.type}
                          </span>
                        </td>
                        <td className="px-3 py-3 align-top">
                          <div className="flex items-start gap-2">
                            <div className="max-w-[280px] truncate font-mono text-sm text-slate-200" title={record.value}>
                              {record.value}
                            </div>
                            <CopyButton text={record.value} className="px-2 py-1" />
                          </div>
                        </td>
                        <td className="px-3 py-3 align-top text-slate-300">{record.ttl}s</td>
                        <td className="px-3 py-3 align-top text-slate-400">
                          {record.updatedAt ? <span title={record.updatedAt}>{timeAgo(record.updatedAt)}</span> : "—"}
                        </td>
                        <td className="px-3 py-3 align-top">
                          <div className="flex justify-end gap-2">
                            <button
                              onClick={() => {
                                setEditingRecord(record);
                                setDialogDefaults({});
                                setDialogOpen(true);
                              }}
                              className="rounded-lg border border-white/10 bg-slate-950 p-2 text-slate-300 transition hover:text-white"
                              title={`Edit ${record.name}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => setRecordToDelete(record)}
                              className="rounded-lg border border-red-500/20 bg-red-500/10 p-2 text-red-300 transition hover:bg-red-500/20"
                              title={`Delete ${record.name}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-slate-400">
                <div>
                  Showing {(currentPage - 1) * pageSize + 1}-{Math.min(currentPage * pageSize, filteredRecords.length)} of {filteredRecords.length} {tab} records
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                    disabled={currentPage === 1}
                    className="rounded-lg border border-white/10 px-3 py-2 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <span className="text-xs uppercase tracking-[0.2em] text-slate-500">Page {currentPage} / {totalPages}</span>
                  <button
                    onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                    disabled={currentPage === totalPages}
                    className="rounded-lg border border-white/10 px-3 py-2 transition hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-white">Game server quick-add</p>
            <p className="mt-1 text-sm text-slate-400">Use current node IPs from Game Hub and jump into server details for one-click DNS creation.</p>
          </div>
          <Link href="/game-hub" className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-sm text-slate-300 transition hover:text-white">
            <Gamepad2 className="h-4 w-4" />
            Open Game Hub
          </Link>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {gameServerTargets.length > 0 ? gameServerTargets.slice(0, 3).map((server) => (
            <div key={server.label} className="rounded-xl border border-white/10 bg-slate-950/70 p-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="font-medium text-white">{server.label}</p>
                  <p className="mt-1 font-mono text-xs text-cyan-200">{server.value}</p>
                </div>
                <StatusBadge status="healthy" label="Ready" size="sm" />
              </div>
              <div className="mt-3 flex items-center justify-between gap-2">
                <Link href={server.href ?? "/game-hub"} className="text-xs text-cyan-200 hover:text-white">Open details</Link>
                <button
                  onClick={() => {
                    setEditingRecord(null);
                    setDialogDefaults({ name: server.label, value: server.value, type: "A", internal: true });
                    setDialogOpen(true);
                  }}
                  className="rounded-lg border border-cyan-500/20 bg-cyan-500/10 px-2.5 py-1.5 text-xs text-cyan-100 transition hover:bg-cyan-500/20"
                >
                  New DNS
                </button>
              </div>
            </div>
          )) : <p className="text-sm text-slate-500">No Game Hub servers with node IPs were detected yet.</p>}
        </div>
      </div>

      {dialogOpen ? (
        <DnsRecordDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          record={editingRecord}
          defaultValues={dialogDefaults}
          draftKey={!editingRecord ? "infraweaver:dns-create-draft" : undefined}
          currentMachineTargets={machineTargets}
          gameServerTargets={gameServerTargets}
          onSubmitted={async () => {
            await refetch();
          }}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(recordToDelete)}
        onCancel={() => setRecordToDelete(null)}
        onConfirm={() => void deleteRecord()}
        title={`Delete ${recordToDelete?.name ?? "DNS record"}?`}
        description={recordToDelete
          ? `This permanently removes the ${recordToDelete.internal ? "internal" : "public"} ${recordToDelete.type} record pointing to ${recordToDelete.value}.`
          : undefined}
        confirmText="Delete record"
        danger
      />
    </div>
  );
}
