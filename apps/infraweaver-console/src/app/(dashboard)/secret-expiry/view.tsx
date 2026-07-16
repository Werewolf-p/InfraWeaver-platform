"use client";
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ShieldCheck, Lock, ShieldX, AlertTriangle, Clock, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { AsyncBoundary, FilterSelect, SearchInput } from "@/components/ui";
import { useApiQuery } from "@/hooks/use-api-query";

interface Secret {
  namespace: string;
  name: string;
  expiresAt: string;
  daysLeft: number;
  expired: boolean;
}

const TICK_INTERVAL_MS = 30_000;

/** Re-render on an interval so the live countdown stays fresh between refetches. */
function useNowTick(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Live remaining seconds from the absolute expiry timestamp. */
function remainingSeconds(expiresAt: string, now: number): number | null {
  const expiresMs = new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresMs)) return null;
  return Math.round((expiresMs - now) / 1000);
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "expired";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${hours}h ${minutes}m`;
}

type Bucket = "expired" | "critical" | "soon" | "healthy";

const BUCKET_META: Record<Bucket, { label: string; hint: string; icon: typeof ShieldX; badge: string; dot: string; accent: string }> = {
  expired: { label: "Expired", hint: "Rotate now — already invalid", icon: ShieldX, badge: "text-red-400 bg-red-500/10 border-red-500/20", dot: "bg-red-400", accent: "text-red-500 dark:text-red-400" },
  critical: { label: "Critical · ≤14 days", hint: "Rotate this week", icon: AlertTriangle, badge: "text-orange-400 bg-orange-500/10 border-orange-500/20", dot: "bg-orange-400", accent: "text-orange-500 dark:text-orange-400" },
  soon: { label: "Soon · ≤30 days", hint: "Schedule rotation", icon: Clock, badge: "text-yellow-500 dark:text-yellow-400 bg-yellow-500/10 border-yellow-500/20", dot: "bg-yellow-400", accent: "text-yellow-600 dark:text-yellow-400" },
  healthy: { label: "Healthy · >30 days", hint: "No action needed", icon: CheckCircle2, badge: "text-green-500 dark:text-green-400 bg-green-500/10 border-green-500/20", dot: "bg-green-400", accent: "text-green-600 dark:text-green-400" },
};

const BUCKET_ORDER: Bucket[] = ["expired", "critical", "soon", "healthy"];

function bucketFor(secret: Secret, remaining: number | null): Bucket {
  const days = remaining !== null ? remaining / 86_400 : secret.daysLeft;
  if (secret.expired || days <= 0) return "expired";
  if (days <= 14) return "critical";
  if (days <= 30) return "soon";
  return "healthy";
}

const ALL_NAMESPACES = "all";

export function SecretExpiryView() {
  const now = useNowTick(TICK_INTERVAL_MS);
  const { data, isLoading, isError, refetch } = useApiQuery<{ secrets: Secret[] }>({
    queryKey: ["security", "secrets"],
    path: "/api/security/secrets",
  });

  const [query, setQuery] = useState("");
  const [namespace, setNamespace] = useState(ALL_NAMESPACES);

  const allSecrets = useMemo(() => data?.secrets ?? [], [data?.secrets]);

  const namespaceOptions = useMemo(() => {
    const names = Array.from(new Set(allSecrets.map((s) => s.namespace))).sort((a, b) => a.localeCompare(b));
    return [{ value: ALL_NAMESPACES, label: "All namespaces" }, ...names.map((n) => ({ value: n, label: n }))];
  }, [allSecrets]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allSecrets.filter((s) => {
      if (namespace !== ALL_NAMESPACES && s.namespace !== namespace) return false;
      if (!needle) return true;
      return s.name.toLowerCase().includes(needle) || s.namespace.toLowerCase().includes(needle);
    });
  }, [allSecrets, namespace, query]);

  const grouped = useMemo(() => {
    const groups: Record<Bucket, Array<{ secret: Secret; remaining: number | null }>> = {
      expired: [], critical: [], soon: [], healthy: [],
    };
    for (const secret of filtered) {
      const remaining = remainingSeconds(secret.expiresAt, now);
      groups[bucketFor(secret, remaining)].push({ secret, remaining });
    }
    for (const key of BUCKET_ORDER) {
      groups[key].sort((a, b) => (a.remaining ?? a.secret.daysLeft * 86_400) - (b.remaining ?? b.secret.daysLeft * 86_400));
    }
    return groups;
  }, [filtered, now]);

  const expired = allSecrets.filter((s) => s.expired).length;
  const expiringSoon = allSecrets.filter((s) => !s.expired && s.daysLeft <= 30).length;

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <PageHeader icon={Lock} title="Secret Expiry" />
      <div>
        <h2 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-slate-500 dark:text-slate-400" />Secret Expiry Tracker</h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">TLS certificate and secret expiration monitoring — live countdowns, grouped by urgency</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[
          { label: "Total TLS Secrets", value: allSecrets.length, color: "text-gray-900 dark:text-white" },
          { label: "Expired", value: expired, color: expired > 0 ? "text-red-400" : "text-green-500 dark:text-green-400" },
          { label: "Expiring ≤30 days", value: expiringSoon, color: expiringSoon > 0 ? "text-yellow-600 dark:text-yellow-400" : "text-green-500 dark:text-green-400" },
        ].map((s) => (
          <div key={s.label} className="bg-slate-100 dark:bg-slate-900/60 border border-gray-200 dark:border-white/10 rounded-xl backdrop-blur-sm p-4 text-center">
            <p className="text-xs text-slate-500 dark:text-slate-400">{s.label}</p>
            <p className={`text-3xl font-bold mt-1 ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <SearchInput placeholder="Search secret or namespace…" value={query} onChange={setQuery} />
        <FilterSelect label="Namespace" value={namespace} options={namespaceOptions} onChange={setNamespace} />
      </div>

      <AsyncBoundary
        isLoading={isLoading}
        isError={isError}
        isEmpty={!isLoading && !isError && filtered.length === 0}
        onRetry={() => void refetch()}
        emptyTitle={allSecrets.length === 0 ? "No TLS secrets found" : "No secrets match these filters"}
      >
        <div className="space-y-4">
          {BUCKET_ORDER.map((bucket) => {
            const rows = grouped[bucket];
            if (rows.length === 0) return null;
            const meta = BUCKET_META[bucket];
            const Icon = meta.icon;
            return (
              <section key={bucket} className="overflow-hidden rounded-xl border border-gray-200 dark:border-white/10 bg-slate-100 dark:bg-slate-900/60 backdrop-blur-sm">
                <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-gray-200 dark:border-white/10 bg-slate-100/95 dark:bg-slate-900/90 px-4 py-2.5 backdrop-blur-sm">
                  <div className="flex items-center gap-2">
                    <Icon className={cn("h-4 w-4", meta.accent)} aria-hidden="true" />
                    <span className={cn("text-sm font-semibold", meta.accent)}>{meta.label}</span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">{meta.hint}</span>
                  </div>
                  <span className={cn("rounded-full border px-2 py-0.5 text-xs font-semibold", meta.badge)}>{rows.length}</span>
                </div>
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-white/10">
                      <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500 dark:text-slate-400">Secret</th>
                      <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500 dark:text-slate-400">Namespace</th>
                      <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500 dark:text-slate-400">Expires</th>
                      <th className="text-right px-4 py-2 text-xs font-semibold text-slate-500 dark:text-slate-400">Countdown</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ secret, remaining }) => (
                      <tr key={`${secret.namespace}/${secret.name}`} className="border-b border-gray-200 dark:border-white/5 last:border-0 hover:bg-gray-100 dark:hover:bg-white/5 transition-colors">
                        <td className="px-4 py-3 text-sm text-gray-900 dark:text-white font-medium">{secret.name}</td>
                        <td className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">{secret.namespace}</td>
                        <td className="px-4 py-3 text-sm text-slate-700 dark:text-slate-300" title={new Date(secret.expiresAt).toISOString()}>{new Date(secret.expiresAt).toLocaleDateString()}</td>
                        <td className="px-4 py-3 text-right">
                          <span
                            className={cn("inline-flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border font-semibold tabular-nums", meta.badge)}
                            title={secret.expired ? "Certificate has already expired" : `Expires ${new Date(secret.expiresAt).toLocaleString()}`}
                          >
                            <span className={cn("h-1.5 w-1.5 rounded-full", meta.dot)} aria-hidden="true" />
                            {bucket === "expired" || remaining === null || remaining <= 0 ? "EXPIRED" : formatCountdown(remaining)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            );
          })}
        </div>
      </AsyncBoundary>
    </motion.div>
  );
}
