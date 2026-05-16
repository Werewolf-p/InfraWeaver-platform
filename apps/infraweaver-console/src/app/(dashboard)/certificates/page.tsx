"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Search, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/utils";

interface Certificate {
  id: string;
  name: string;
  namespace: string;
  secretName: string | null;
  commonName: string | null;
  dnsNames: string[];
  issuerRef: string | null;
  ready: boolean;
  valid: boolean;
  status: string;
  reason: string | null;
  notAfter: string | null;
  renewalTime: string | null;
  daysLeft: number | null;
  revision: number | null;
  source: "cert-manager" | "tls-secret";
}

interface CertificateResponse {
  certs: Certificate[];
  live: boolean;
  summary: { total: number; ready: number; expiringSoon: number; renewalDue: number };
}

function formatDateTime(value: string | null) {
  if (!value) return "Unknown";
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function statusClass(cert: Certificate) {
  if (!cert.ready) return "border-red-500/30 bg-red-500/10 text-red-200";
  if (cert.daysLeft !== null && cert.daysLeft <= 14) return "border-red-500/30 bg-red-500/10 text-red-200";
  if (cert.daysLeft !== null && cert.daysLeft <= 30) return "border-yellow-500/30 bg-yellow-500/10 text-yellow-100";
  return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
}

export default function CertificatesPage() {
  const [search, setSearch] = useState("");
  const [namespaceFilter, setNamespaceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "expiring" | "renewal" | "not-ready">("all");
  const [renewalCutoff] = useState(() => Date.now() + 7 * 86_400_000);

  const { data, isLoading, isFetching, refetch } = useQuery<CertificateResponse>({
    queryKey: ["certificates"],
    queryFn: async () => {
      const response = await fetch("/api/certificates", { cache: "no-store" });
      if (!response.ok) throw new Error("Failed to fetch certificates");
      return response.json();
    },
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  const certs = useMemo(() => data?.certs ?? [], [data?.certs]);
  const namespaces = useMemo(() => Array.from(new Set(certs.map((cert) => cert.namespace))).sort(), [certs]);
  const filtered = useMemo(() => certs.filter((cert) => {
    const query = search.trim().toLowerCase();
    const hostnames = [cert.commonName, ...cert.dnsNames].filter(Boolean).join(" ").toLowerCase();
    const matchesSearch = !query
      || cert.name.toLowerCase().includes(query)
      || cert.namespace.toLowerCase().includes(query)
      || hostnames.includes(query)
      || (cert.secretName ?? "").toLowerCase().includes(query);
    const matchesNamespace = namespaceFilter === "all" || cert.namespace === namespaceFilter;
    const matchesStatus = statusFilter === "all"
      || (statusFilter === "expiring" && cert.daysLeft !== null && cert.daysLeft <= 30)
      || (statusFilter === "renewal" && cert.renewalTime !== null && new Date(cert.renewalTime).getTime() <= renewalCutoff)
      || (statusFilter === "not-ready" && !cert.ready);
    return matchesSearch && matchesNamespace && matchesStatus;
  }), [certs, namespaceFilter, renewalCutoff, search, statusFilter]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={ShieldCheck}
        title="Certificates"
        subtitle="cert-manager certificate inventory with expiry, issuer, and renewal visibility"
        badge={data?.live === false ? "offline" : "live"}
        actions={
          <button
            onClick={() => void refetch()}
            className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300 transition hover:text-white"
          >
            <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
            Refresh
          </button>
        }
      />

      {data?.live === false ? (
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          cert-manager unavailable — certificate data cannot be loaded. Check cert-manager namespace.
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Certificates</p>
          <p className="mt-2 text-3xl font-semibold text-white">{data?.summary.total ?? 0}</p>
        </div>
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-emerald-100/80">Ready</p>
          <p className="mt-2 text-3xl font-semibold text-emerald-300">{data?.summary.ready ?? 0}</p>
        </div>
        <div className="rounded-2xl border border-yellow-500/20 bg-yellow-500/10 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-yellow-100/80">Expiring ≤30d</p>
          <p className="mt-2 text-3xl font-semibold text-yellow-200">{data?.summary.expiringSoon ?? 0}</p>
        </div>
        <div className="rounded-2xl border border-indigo-500/20 bg-indigo-500/10 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-indigo-100/80">Renewal due</p>
          <p className="mt-2 text-3xl font-semibold text-indigo-200">{data?.summary.renewalDue ?? 0}</p>
        </div>
      </div>

      <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by host, namespace, certificate, or secret…"
              className="w-full rounded-xl border border-white/10 bg-slate-950 py-2.5 pl-9 pr-3 text-sm text-white outline-none focus:border-indigo-500/50"
            />
          </div>
          <select
            value={namespaceFilter}
            onChange={(event) => setNamespaceFilter(event.target.value)}
            className="rounded-xl border border-white/10 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none"
          >
            <option value="all">All namespaces</option>
            {namespaces.map((namespace) => <option key={namespace} value={namespace}>{namespace}</option>)}
          </select>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
            className="rounded-xl border border-white/10 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none"
          >
            <option value="all">All states</option>
            <option value="expiring">Expiring soon</option>
            <option value="renewal">Renewal due</option>
            <option value="not-ready">Not ready</option>
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 xl:grid-cols-2">{Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-56 rounded-2xl bg-white/5 animate-pulse" />)}</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 bg-slate-950/40 py-16 text-center text-sm text-slate-500">
          No certificates matched the current filters.
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {filtered.map((cert) => (
            <div key={cert.id} className="rounded-2xl border border-white/10 bg-slate-900/70 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold text-white">{cert.name}</h2>
                    <span className={cn("rounded-full border px-2.5 py-1 text-xs", statusClass(cert))}>{cert.status}</span>
                  </div>
                  <p className="mt-1 text-sm text-slate-400">{cert.namespace} · {cert.source === "cert-manager" ? "cert-manager" : "TLS secret scan"}</p>
                </div>
                <div className="text-right text-sm text-slate-400">
                  <p className="font-medium text-white">{cert.daysLeft === null ? "Unknown" : `${cert.daysLeft} days`}</p>
                  <p>Expires {formatDateTime(cert.notAfter)}</p>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {(cert.dnsNames.length > 0 ? cert.dnsNames : [cert.commonName]).filter(Boolean).map((host) => (
                  <span key={host} className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2.5 py-1 text-xs text-cyan-200">{host}</span>
                ))}
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Issuer</p>
                  <p className="mt-2 text-sm text-white">{cert.issuerRef ?? "Unknown"}</p>
                </div>
                <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Secret</p>
                  <p className="mt-2 text-sm text-white">{cert.secretName ?? "Unknown"}</p>
                </div>
                <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Renewal time</p>
                  <p className="mt-2 text-sm text-white">{formatDateTime(cert.renewalTime)}</p>
                </div>
                <div className="rounded-xl border border-white/10 bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Revision</p>
                  <p className="mt-2 text-sm text-white">{cert.revision ?? "—"}</p>
                </div>
              </div>

              {cert.reason ? <p className="mt-4 text-sm text-red-200">{cert.reason}</p> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
