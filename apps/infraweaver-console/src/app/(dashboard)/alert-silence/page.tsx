"use client";
import { motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { BellOff, BellRing, CalendarClock, History, Plus, Trash2 } from "lucide-react";
import { PageScaffold } from "@/components/ui/page-scaffold";
import { useApiMutation, useApiQuery } from "@/hooks/use-api-query";
import { useConfirm } from "@/hooks/use-confirm";
import { useRBAC } from "@/hooks/use-rbac";
import { cn } from "@/lib/utils";

interface Silence {
  id: string;
  name: string;
  matchers: string;
  startsAt: string;
  endsAt: string;
  comment: string;
  createdBy: string;
}

type SilenceStatus = "active" | "scheduled" | "expired";

const STATUS_RANK: Record<SilenceStatus, number> = { active: 0, scheduled: 1, expired: 2 };

function silenceStatus(silence: Silence, now: number): SilenceStatus {
  const start = silence.startsAt ? new Date(silence.startsAt).getTime() : 0;
  const end = new Date(silence.endsAt).getTime();
  if (Number.isFinite(end) && now >= end) return "expired";
  if (start && now < start) return "scheduled";
  return "active";
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(Math.abs(ms) / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

function countdownLabel(silence: Silence, status: SilenceStatus, now: number): string {
  const start = silence.startsAt ? new Date(silence.startsAt).getTime() : 0;
  const end = new Date(silence.endsAt).getTime();
  if (status === "scheduled") return `Starts in ${formatDuration(start - now)}`;
  if (status === "active") return `Expires in ${formatDuration(end - now)}`;
  return `Expired ${formatDuration(now - end)} ago`;
}

/** Split a Prometheus-style matcher string (`a="1", b="2"`) into trimmed chips. */
function parseMatchers(raw: string): string[] {
  return raw
    .split(/,(?![^"]*"(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

const STATUS_META: Record<SilenceStatus, { label: string; icon: typeof BellRing; badge: string }> = {
  active: {
    label: "Active",
    icon: BellRing,
    badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  },
  scheduled: {
    label: "Scheduled",
    icon: CalendarClock,
    badge: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  },
  expired: {
    label: "Expired",
    icon: History,
    badge: "border-slate-500/30 bg-slate-500/10 text-slate-400",
  },
};

export default function AlertSilencePage() {
  const { can } = useRBAC();
  const canManageSilences = can("config:write");
  const { confirm, confirmDialog } = useConfirm();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(() => ({ name: "", matchers: "", comment: "", endsAt: new Date(Date.now() + 3600000).toISOString().slice(0, 16) }));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const { data, isLoading } = useApiQuery<{ silences: Silence[] }>({
    queryKey: ["alert-silences"],
    path: "/api/alerts/silence",
  });

  const silences = useMemo(() => data?.silences ?? [], [data?.silences]);

  const sorted = useMemo(() => {
    return [...silences].sort((a, b) => {
      const sa = silenceStatus(a, now);
      const sb = silenceStatus(b, now);
      if (STATUS_RANK[sa] !== STATUS_RANK[sb]) return STATUS_RANK[sa] - STATUS_RANK[sb];
      const ea = new Date(a.endsAt).getTime();
      const eb = new Date(b.endsAt).getTime();
      // Active / scheduled: soonest boundary first. Expired: most recently lapsed first.
      return sa === "expired" ? eb - ea : ea - eb;
    });
  }, [silences, now]);

  const activeCount = useMemo(() => silences.filter((s) => silenceStatus(s, now) === "active").length, [silences, now]);

  const createMutation = useApiMutation<unknown, typeof form>({
    path: "/api/alerts/silence",
    request: (body) => ({ json: { ...body, endsAt: new Date(body.endsAt).toISOString() } }),
    successMessage: "Silence created",
    errorMessage: "Failed to create silence",
    invalidateQueryKeys: [["alert-silences"]],
    onSuccess: () => setShowForm(false),
  });

  const deleteMutation = useApiMutation<unknown, string>({
    method: "DELETE",
    path: (id) => `/api/alerts/silence?id=${id}`,
    successMessage: "Silence removed",
    invalidateQueryKeys: [["alert-silences"]],
  });

  const handleDelete = async (silence: Silence) => {
    if (!canManageSilences) return;
    const status = silenceStatus(silence, now);
    const confirmed = await confirm({
      title: `Delete silence "${silence.name}"?`,
      description: status === "active"
        ? "This silence is active right now — removing it will immediately let its matched alerts fire again."
        : "This will permanently remove the silence.",
      confirmText: "Delete silence",
      danger: true,
    });
    if (confirmed) deleteMutation.mutate(silence.id);
  };

  if (isLoading) return <div className="space-y-4">{[...Array(3)].map((_, i) => <div key={i} className="h-16 rounded-xl bg-gray-100 dark:bg-white/5 animate-pulse" />)}</div>;

  return (
    <PageScaffold icon={BellOff} title="Alert Silence">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-gray-900 dark:text-white flex items-center gap-2"><BellOff className="w-5 h-5 text-slate-500 dark:text-slate-400" />Alert Silencing</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {activeCount > 0
              ? `${activeCount} suppression${activeCount === 1 ? "" : "s"} in effect right now`
              : "Manage alert silences and suppressions"}
          </p>
        </div>
        <button onClick={() => canManageSilences && setShowForm(v => !v)} disabled={!canManageSilences} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:cursor-not-allowed disabled:opacity-50">
          <Plus className="w-4 h-4" />New Silence
        </button>
      </div>

      {showForm && (
        <div className="bg-slate-100 dark:bg-slate-900/60 border border-gray-200 dark:border-white/10 rounded-xl backdrop-blur-sm p-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Create Silence</h3>
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Silence name" className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50" />
          <input value={form.matchers} onChange={e => setForm(f => ({ ...f, matchers: e.target.value }))} placeholder='Matchers e.g. alertname="HighCPU", severity="critical"' className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50" />
          {form.matchers.trim() && (
            <div className="flex flex-wrap gap-1.5">
              {parseMatchers(form.matchers).map((matcher, i) => (
                <span key={`${matcher}-${i}`} className="rounded-md border border-indigo-500/20 bg-indigo-500/10 px-2 py-0.5 font-mono text-[11px] text-indigo-300">{matcher}</span>
              ))}
            </div>
          )}
          <input value={form.comment} onChange={e => setForm(f => ({ ...f, comment: e.target.value }))} placeholder="Comment" className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50" />
          <div>
            <label className="text-xs text-slate-500 dark:text-slate-400 mb-1 block">Ends At</label>
            <input type="datetime-local" value={form.endsAt} onChange={e => setForm(f => ({ ...f, endsAt: e.target.value }))} className="w-full px-3 py-2 rounded-lg bg-gray-100 dark:bg-white/5 border border-gray-200 dark:border-white/10 text-sm text-gray-900 dark:text-white outline-none focus:border-indigo-500/50" />
          </div>
          <button onClick={() => createMutation.mutate(form)} disabled={createMutation.isPending || !canManageSilences || !form.name.trim() || !form.matchers.trim()} className="w-full py-2 rounded-lg bg-indigo-500/20 border border-indigo-500/30 text-sm text-indigo-300 hover:bg-indigo-500/30 transition-colors disabled:opacity-50">
            {createMutation.isPending ? "Creating..." : "Create"}
          </button>
        </div>
      )}

      <div className="space-y-3">
        {silences.length === 0 && <div className="py-12 text-center text-slate-500 text-sm">No active silences</div>}
        {sorted.map(s => {
          const status = silenceStatus(s, now);
          const meta = STATUS_META[status];
          const StatusIcon = meta.icon;
          const matchers = parseMatchers(s.matchers);
          return (
            <div
              key={s.id}
              className={cn(
                "bg-slate-100 dark:bg-slate-900/60 border rounded-xl backdrop-blur-sm p-4 flex items-start justify-between transition-colors",
                status === "active" ? "border-emerald-500/20 dark:border-emerald-500/20" : "border-gray-200 dark:border-white/10",
                status === "expired" && "opacity-70",
              )}
            >
              <div className="min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", meta.badge)}>
                    <StatusIcon className="h-3 w-3" aria-hidden="true" />
                    {meta.label}
                  </span>
                  <p className="text-sm font-semibold text-gray-900 dark:text-white truncate">{s.name}</p>
                  <span
                    className={cn(
                      "text-xs tabular-nums",
                      status === "active" ? "text-emerald-500 dark:text-emerald-300" : status === "scheduled" ? "text-sky-500 dark:text-sky-300" : "text-slate-500",
                    )}
                  >
                    {countdownLabel(s, status, now)}
                  </span>
                </div>
                {matchers.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {matchers.map((matcher, i) => (
                      <span key={`${matcher}-${i}`} className="rounded-md border border-gray-200 bg-gray-100 px-2 py-0.5 font-mono text-[11px] text-slate-600 dark:border-white/10 dark:bg-white/5 dark:text-slate-300">{matcher}</span>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500 dark:text-slate-400">No matchers</p>
                )}
                <p className="text-xs text-slate-500">Ends {new Date(s.endsAt).toLocaleString()} · by {s.createdBy}</p>
                {s.comment && <p className="text-xs text-slate-500 italic">{s.comment}</p>}
              </div>
              <button
                onClick={() => void handleDelete(s)}
                disabled={!canManageSilences || deleteMutation.isPending}
                aria-label={`Delete silence ${s.name}`}
                className="text-red-400 hover:text-red-300 transition-colors flex-shrink-0 ml-4 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>
      {confirmDialog}
      </motion.div>
    </PageScaffold>
  );
}
