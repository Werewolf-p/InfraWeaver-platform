"use client";

import { useMemo, useState } from "react";
import { RefreshCw, Search, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { useApiQuery } from "@/hooks/use-api-query";
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

// Window used to scale the expiry bar: a healthy 90+ day cert fills the track.
const EXPIRY_HORIZON_DAYS = 90;

type ExpiryTone = "red" | "amber" | "green";

const TONE_BAR: Record<ExpiryTone, string> = {
  red: "bg-red-500",
  amber: "bg-amber-400",
  green: "bg-emerald-500",
};

const TONE_TEXT: Record<ExpiryTone, string> = {
  red: "text-red-600 dark:text-red-300",
  amber: "text-amber-600 dark:text-amber-300",
  green: "text-emerald-600 dark:text-emerald-300",
};

function expiryTone(cert: Certificate): ExpiryTone {
  if (!cert.ready) return "red";
  if (cert.daysLeft !== null && cert.daysLeft <= 14) return "red";
  if (cert.daysLeft !== null && cert.daysLeft <= 30) return "amber";
  return "green";
}

function expiryPercent(cert: Certificate): number {
  if (cert.daysLeft === null) return cert.ready ? 100 : 6;
  return Math.max(4, Math.min(100, Math.round((cert.daysLeft / EXPIRY_HORIZON_DAYS) * 100)));
}

function relativeExpiry(cert: Certificate): string {
  const days = cert.daysLeft;
  if (days === null) return "Expiry unknown";
  if (days < 0) return `Expired ${Math.abs(days)}d ago`;
  if (days === 0) return "Expires today";
  if (days === 1) return "in 1 day";
  return `in ${days} days`;
}

// Not-ready certs float to the top, then the soonest-to-expire; unknowns sink last.
function compareByRisk(a: Certificate, b: Certificate): number {
  if (a.ready !== b.ready) return a.ready ? 1 : -1;
  const da = a.daysLeft ?? Number.MAX_SAFE_INTEGER;
  const db = b.daysLeft ?? Number.MAX_SAFE_INTEGER;
  return da - db;
}

function ExpiryMeter({ cert }: { cert: Certificate }) {
  const tone = expiryTone(cert);
  const label = relativeExpiry(cert);
  return (
    <div className="mt-4" role="img" aria-label={`Certificate ${cert.ready ? "" : "not ready — "}expires ${label}`}>
      <div className="flex items-center justify-between text-xs">
        <span className={cn("font-medium", TONE_TEXT[tone])}>{cert.ready ? label : "Not ready"}</span>
        <span className="text-slate-500 dark:text-slate-400">{cert.daysLeft !== null ? `${cert.daysLeft}d of ${EXPIRY_HORIZON_DAYS}d` : "—"}</span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
        <div className={cn("h-full rounded-full transition-[width] motion-reduce:transition-none", TONE_BAR[tone])} style={{ width: `${expiryPercent(cert)}%` }} />
      </div>
    </div>
  );
}

export function CertificatesView() {
  const [search, setSearch] = useState("");
  const [namespaceFilter, setNamespaceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "expiring" | "renewal" | "not-ready">("all");
  const [renewalCutoff] = useState(() => Date.now() + 7 * 86_400_000);

  const { data, isLoading, isFetching, refetch } = useApiQuery<CertificateResponse>({
    queryKey: ["certificates"],
    path: "/api/certificates",
    request: { cache: "no-store" },
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
  }).sort(compareByRisk), [certs, namespaceFilter, renewalCutoff, search, statusFilter]);

  function toggleStatus(next: Exclude<typeof statusFilter, "all">) {
    setStatusFilter((current) => (current === next ? "all" : next));
  }

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
            className="inline-flex items-center gap-2 rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-3 py-2 text-sm text-slate-700 dark:text-slate-300 transition hover:text-gray-900 dark:hover:text-white"
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
        <button
          type="button"
          onClick={() => setStatusFilter("all")}
          aria-pressed={statusFilter === "all"}
          className="rounded-2xl border border-gray-200 text-left transition hover:border-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 dark:border-white/10 dark:hover:border-white/20 bg-slate-100 dark:bg-slate-900/70 p-4"
        >
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Certificates</p>
          <p className="mt-2 text-3xl font-semibold text-gray-900 dark:text-white">{data?.summary.total ?? 0}</p>
          <p className="mt-1 text-[11px] text-slate-500">Show all</p>
        </button>
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
          <p className="text-xs uppercase tracking-[0.2em] text-emerald-100/80">Ready</p>
          <p className="mt-2 text-3xl font-semibold text-emerald-300">{data?.summary.ready ?? 0}</p>
        </div>
        <button
          type="button"
          onClick={() => toggleStatus("expiring")}
          aria-pressed={statusFilter === "expiring"}
          className={cn(
            "rounded-2xl border text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-500/60 p-4",
            statusFilter === "expiring"
              ? "border-yellow-400/60 bg-yellow-500/20 ring-1 ring-yellow-400/40"
              : "border-yellow-500/20 bg-yellow-500/10 hover:border-yellow-400/40",
          )}
        >
          <p className="text-xs uppercase tracking-[0.2em] text-yellow-100/80">Expiring ≤30d</p>
          <p className="mt-2 text-3xl font-semibold text-yellow-200">{data?.summary.expiringSoon ?? 0}</p>
          <p className="mt-1 text-[11px] text-yellow-200/70">{statusFilter === "expiring" ? "Filtering · tap to clear" : "Tap to filter"}</p>
        </button>
        <button
          type="button"
          onClick={() => toggleStatus("renewal")}
          aria-pressed={statusFilter === "renewal"}
          className={cn(
            "rounded-2xl border text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 p-4",
            statusFilter === "renewal"
              ? "border-indigo-400/60 bg-indigo-500/20 ring-1 ring-indigo-400/40"
              : "border-indigo-500/20 bg-indigo-500/10 hover:border-indigo-400/40",
          )}
        >
          <p className="text-xs uppercase tracking-[0.2em] text-indigo-100/80">Renewal due</p>
          <p className="mt-2 text-3xl font-semibold text-indigo-200">{data?.summary.renewalDue ?? 0}</p>
          <p className="mt-1 text-[11px] text-indigo-200/70">{statusFilter === "renewal" ? "Filtering · tap to clear" : "Tap to filter"}</p>
        </button>
      </div>

      <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by host, namespace, certificate, or secret…"
              className="w-full rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 py-2.5 pl-9 pr-3 text-sm text-gray-900 dark:text-white outline-none focus:border-indigo-500/50"
            />
          </div>
          <select
            value={namespaceFilter}
            onChange={(event) => setNamespaceFilter(event.target.value)}
            className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 px-3 py-2.5 text-sm text-gray-900 dark:text-white outline-none"
          >
            <option value="all">All namespaces</option>
            {namespaces.map((namespace) => <option key={namespace} value={namespace}>{namespace}</option>)}
          </select>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
            className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950 px-3 py-2.5 text-sm text-gray-900 dark:text-white outline-none"
          >
            <option value="all">All states</option>
            <option value="expiring">Expiring soon</option>
            <option value="renewal">Renewal due</option>
            <option value="not-ready">Not ready</option>
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 xl:grid-cols-2">{Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-56 rounded-2xl bg-gray-100 dark:bg-white/5 animate-pulse" />)}</div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/40 py-16 text-center text-sm text-slate-500">
          No certificates matched the current filters.
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {filtered.map((cert) => (
            <div key={cert.id} className="rounded-2xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/70 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{cert.name}</h2>
                    <span className={cn("rounded-full border px-2.5 py-1 text-xs", statusClass(cert))}>{cert.status}</span>
                  </div>
                  <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{cert.namespace} · {cert.source === "cert-manager" ? "cert-manager" : "TLS secret scan"}</p>
                </div>
                <div className="text-right text-sm text-slate-500 dark:text-slate-400">
                  <p className="font-medium text-gray-900 dark:text-white">{cert.daysLeft === null ? "Unknown" : `${cert.daysLeft} days`}</p>
                  <p>Expires {formatDateTime(cert.notAfter)}</p>
                </div>
              </div>

              <ExpiryMeter cert={cert} />

              <div className="mt-4 flex flex-wrap gap-2">
                {(cert.dnsNames.length > 0 ? cert.dnsNames : [cert.commonName]).filter(Boolean).map((host) => (
                  <span key={host} className="rounded-full border border-cyan-500/20 bg-cyan-500/10 px-2.5 py-1 text-xs text-cyan-200">{host}</span>
                ))}
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Issuer</p>
                  <p className="mt-2 text-sm text-gray-900 dark:text-white">{cert.issuerRef ?? "Unknown"}</p>
                </div>
                <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Secret</p>
                  <p className="mt-2 text-sm text-gray-900 dark:text-white">{cert.secretName ?? "Unknown"}</p>
                </div>
                <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Renewal time</p>
                  <p className="mt-2 text-sm text-gray-900 dark:text-white">{formatDateTime(cert.renewalTime)}</p>
                </div>
                <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-950/60 p-3">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Revision</p>
                  <p className="mt-2 text-sm text-gray-900 dark:text-white">{cert.revision ?? "—"}</p>
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
