"use client";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { ShieldCheck, RefreshCw, AlertTriangle, Clock, CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";

interface Certificate {
  name: string;
  namespace: string;
  domain?: string;
  expiresAt?: string;
  daysLeft?: number | null;
  valid: boolean;
}

function ExpiryBadge({ days }: { days: number | null | undefined }) {
  if (days == null) return <span className="text-xs px-2 py-0.5 rounded-full bg-slate-500/15 border border-slate-500/30 text-slate-400">Unknown</span>;
  if (days < 0) return <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 border border-red-500/40 text-red-300 font-medium">Expired</span>;
  if (days < 15) return <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/15 border border-red-500/30 text-red-400 font-semibold">{days}d left</span>;
  if (days < 30) return <span className="text-xs px-2 py-0.5 rounded-full bg-orange-500/15 border border-orange-500/30 text-orange-400 font-medium">{days}d left</span>;
  if (days < 60) return <span className="text-xs px-2 py-0.5 rounded-full bg-yellow-500/15 border border-yellow-500/30 text-yellow-400 font-medium">{days}d left</span>;
  return <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/15 border border-green-500/30 text-green-400">{days}d left</span>;
}

function ExpiryBar({ days }: { days: number | null | undefined }) {
  if (days == null) return null;
  const max = 365;
  const clamped = Math.max(0, Math.min(days, max));
  const pct = (clamped / max) * 100;
  const color = days < 15 ? "bg-red-500" : days < 30 ? "bg-orange-500" : days < 60 ? "bg-yellow-500" : "bg-green-500";
  return (
    <div className="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
      <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="grid grid-cols-[auto_1fr_1fr_auto_auto] gap-4 items-center px-4 py-3.5 border-b border-white/5">
      <div className="w-4 h-4 rounded-full bg-white/10 animate-pulse" />
      <div className="space-y-1.5">
        <div className="w-32 h-3.5 rounded bg-white/10 animate-pulse" />
        <div className="w-20 h-3 rounded bg-white/5 animate-pulse" />
      </div>
      <div className="w-40 h-3.5 rounded bg-white/10 animate-pulse" />
      <div className="w-20 h-5 rounded-full bg-white/10 animate-pulse" />
      <div className="w-24 h-1.5 rounded-full bg-white/10 animate-pulse" />
    </div>
  );
}

export default function CertificatesPage() {
  const { data, isLoading, dataUpdatedAt, refetch, isFetching } = useQuery<Certificate[]>({
    queryKey: ["certificates"],
    queryFn: async () => {
      const res = await fetch("/api/security/certs");
      if (!res.ok) throw new Error("Failed to fetch certificates");
      return res.json();
    },
    refetchInterval: 120000,
    staleTime: 60000,
  });

  const certs = [...(data ?? [])].sort((a, b) => {
    const da = a.daysLeft ?? 9999;
    const db = b.daysLeft ?? 9999;
    return da - db;
  });

  const lastUpdated = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })
    : null;

  const expiringSoon = certs.filter(c => c.daysLeft != null && c.daysLeft < 30).length;
  const critical = certs.filter(c => c.daysLeft != null && c.daysLeft < 15).length;
  const healthy = certs.filter(c => c.valid && (c.daysLeft == null || c.daysLeft >= 60)).length;

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <PageHeader icon={ShieldCheck} title="Certificates" subtitle="TLS certificate status and expiry" />
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center justify-between"
      >
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <ShieldCheck className="w-6 h-6 text-indigo-400" />
            Certificates
          </h1>
          <p className="text-sm text-slate-400 mt-0.5">TLS certificate expiry · cert-manager managed</p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-slate-500 flex items-center gap-1.5">
              <Clock className="w-3 h-3" /> {lastUpdated}
            </span>
          )}
          <button
            onClick={() => refetch()}
            className="p-2 rounded-lg border border-white/10 text-slate-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            <RefreshCw className={cn("w-4 h-4", isFetching && "animate-spin")} />
          </button>
        </div>
      </motion.div>

      {/* Summary cards */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="grid grid-cols-3 gap-4"
      >
        <div className="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
          <div className="text-3xl font-bold text-white tabular-nums">{certs.length}</div>
          <p className="text-xs text-slate-500 uppercase tracking-wider mt-1">Total Certs</p>
        </div>
        <div className={cn(
          "border rounded-xl p-4 text-center",
          critical > 0 ? "bg-red-500/10 border-red-500/30" : expiringSoon > 0 ? "bg-yellow-500/10 border-yellow-500/30" : "bg-white/5 border-white/10"
        )}>
          <div className={cn(
            "text-3xl font-bold tabular-nums",
            critical > 0 ? "text-red-400" : expiringSoon > 0 ? "text-yellow-400" : "text-slate-400"
          )}>
            {expiringSoon}
          </div>
          <p className="text-xs text-slate-500 uppercase tracking-wider mt-1">Expiring &lt;30d</p>
        </div>
        <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-4 text-center">
          <div className="text-3xl font-bold text-green-400 tabular-nums">{healthy}</div>
          <p className="text-xs text-slate-500 uppercase tracking-wider mt-1">Healthy</p>
        </div>
      </motion.div>

      {/* Certs table */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="bg-white/5 border border-white/10 rounded-xl overflow-hidden"
      >
        <div className="grid grid-cols-[auto_1fr_1fr_auto_120px] gap-4 px-4 py-2.5 border-b border-white/5 bg-white/[0.02]">
          <div />
          <span className="text-xs text-slate-500 font-medium uppercase tracking-wide">Certificate</span>
          <span className="text-xs text-slate-500 font-medium uppercase tracking-wide">Domain / Namespace</span>
          <span className="text-xs text-slate-500 font-medium uppercase tracking-wide">Status</span>
          <span className="text-xs text-slate-500 font-medium uppercase tracking-wide">Expiry</span>
        </div>

        {isLoading ? (
          [...Array(5)].map((_, i) => <SkeletonRow key={i} />)
        ) : certs.length === 0 ? (
          <div className="py-16 text-center">
            <AlertTriangle className="w-10 h-10 text-slate-600 mx-auto mb-3" />
            <p className="text-slate-500 text-sm">No certificates found</p>
            <p className="text-xs text-slate-600 mt-1">Requires cert-manager and cluster access</p>
          </div>
        ) : (
          certs.map((cert, idx) => (
            <motion.div
              key={`${cert.namespace}/${cert.name}`}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.03 }}
              className={cn(
                "grid grid-cols-[auto_1fr_1fr_auto_120px] gap-4 items-center px-4 py-3.5 border-b border-white/5 last:border-0 hover:bg-white/[0.02] transition-colors",
                cert.daysLeft != null && cert.daysLeft < 15 && "bg-red-500/5"
              )}
            >
              {/* Status icon */}
              <div>
                {cert.valid ? (
                  <CheckCircle2 className="w-4 h-4 text-green-400" />
                ) : (
                  <XCircle className="w-4 h-4 text-red-400" />
                )}
              </div>

              {/* Name */}
              <div className="min-w-0">
                <p className="text-sm font-medium text-white truncate">{cert.name}</p>
                <p className="text-xs text-slate-500">{cert.namespace}</p>
              </div>

              {/* Domain */}
              <div className="min-w-0">
                <p className="text-sm text-slate-300 font-mono truncate">
                  {cert.domain ?? <span className="text-slate-600">—</span>}
                </p>
                {cert.expiresAt && (
                  <p className="text-xs text-slate-500">
                    Expires {new Date(cert.expiresAt).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })}
                  </p>
                )}
              </div>

              {/* Status badge */}
              <div>
                <ExpiryBadge days={cert.daysLeft} />
              </div>

              {/* Expiry bar */}
              <div className="space-y-1">
                <ExpiryBar days={cert.daysLeft} />
              </div>
            </motion.div>
          ))
        )}
      </motion.div>

      <p className="text-xs text-slate-600 text-center">
        Certificates listed from <span className="font-mono">kubernetes.io/tls</span> secrets · sorted by soonest expiry
      </p>
    </div>
  );
}
