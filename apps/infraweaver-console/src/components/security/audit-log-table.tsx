"use client";
import { useState, useMemo } from "react";
import { motion } from "framer-motion";
import { Download, Filter } from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import type { AuditEntry } from "@/hooks/use-audit-log";

interface AuditLogTableProps {
  entries: AuditEntry[];
  isLoading?: boolean;
}

function ResultBadge({ result }: { result: "success" | "failure" }) {
  return (
    <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-full border",
      result === "success"
        ? "bg-green-500/20 text-green-400 border-green-500/30"
        : "bg-red-500/20 text-red-400 border-red-500/30"
    )}>
      {result === "success" ? "OK" : "FAIL"}
    </span>
  );
}

export function AuditLogTable({ entries, isLoading }: AuditLogTableProps) {
  const [userFilter, setUserFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("");

  const filtered = useMemo(() => entries.filter(e => {
    const matchUser = !userFilter || e.user.toLowerCase().includes(userFilter.toLowerCase());
    const matchAction = !actionFilter || e.action.toLowerCase().includes(actionFilter.toLowerCase());
    return matchUser && matchAction;
  }), [entries, userFilter, actionFilter]);

  const exportCSV = () => {
    const header = "Timestamp,User,Action,Resource,Details,Result,IP";
    const rows = filtered.map(e =>
      [e.timestamp, e.user, e.action, e.resource, e.details, e.result, e.ip ?? ""].map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")
    );
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-12 rounded-lg shimmer-bg" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-2xl border border-white/10 bg-white/5 p-3 sm:border-0 sm:bg-transparent sm:p-0">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-[160px] flex-1 items-center gap-2">
            <Filter className="h-4 w-4 flex-shrink-0 text-slate-500" />
            <input
              type="text"
              placeholder="Filter by user"
              value={userFilter}
              onChange={e => setUserFilter(e.target.value)}
              className="min-h-[48px] flex-1 rounded-2xl border border-white/10 bg-white/5 px-4 text-base text-white placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 sm:text-sm"
            />
          </div>
          <input
            type="text"
            placeholder="Filter by action"
            value={actionFilter}
            onChange={e => setActionFilter(e.target.value)}
            className="min-h-[48px] min-w-[160px] flex-1 rounded-2xl border border-white/10 bg-white/5 px-4 text-base text-white placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/50 sm:text-sm"
          />
          <button
            onClick={exportCSV}
            className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-2xl border border-white/10 bg-white/5 px-4 text-sm font-medium text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </button>
        </div>
        <p className="text-sm text-slate-500">Audit filters stay visible below the inputs on mobile so you can refine results without hiding controls.</p>
      </div>

      <div className="space-y-3 sm:hidden">
        {filtered.map((entry, i) => (
          <motion.div
            key={`${entry.timestamp}-${i}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.03 }}
            className={cn("rounded-2xl border p-4", entry.result === "failure" ? "border-red-500/20 bg-red-500/5" : "border-white/10 bg-white/5")}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-base font-semibold text-white">{entry.user}</p>
                <p className="mt-1 truncate font-mono text-sm text-slate-300">{entry.action}</p>
              </div>
              <ResultBadge result={entry.result} />
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm text-slate-400">
              <div>
                <dt className="text-slate-500">Time</dt>
                <dd className="mt-1 text-white">{timeAgo(entry.timestamp)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">IP</dt>
                <dd className="mt-1 text-white">{entry.ip ?? "—"}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-slate-500">Resource</dt>
                <dd className="mt-1 text-white">{entry.resource || "—"}</dd>
              </div>
              {entry.details ? (
                <div className="col-span-2">
                  <dt className="text-slate-500">Details</dt>
                  <dd className="mt-1 text-white">{entry.details}</dd>
                </div>
              ) : null}
            </dl>
          </motion.div>
        ))}
      </div>

      <div className="hidden overflow-x-auto -mx-1 sm:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/5 text-slate-500">
              <th className="px-1 pb-2 text-left font-medium">Time</th>
              <th className="px-1 pb-2 text-left font-medium">User</th>
              <th className="px-1 pb-2 text-left font-medium">Action</th>
              <th className="hidden px-1 pb-2 text-left font-medium sm:table-cell">Resource</th>
              <th className="px-1 pb-2 text-left font-medium">Result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {filtered.map((entry, i) => (
              <motion.tr
                key={`${entry.timestamp}-${i}`}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.03 }}
                className={cn("transition-colors", entry.result === "failure" && "bg-red-500/5")}
              >
                <td className="whitespace-nowrap px-1 py-2 text-slate-400">{timeAgo(entry.timestamp)}</td>
                <td className="max-w-[120px] truncate px-1 py-2 text-slate-300">{entry.user}</td>
                <td className="px-1 py-2 font-mono text-slate-400">{entry.action}</td>
                <td className="hidden max-w-[140px] truncate px-1 py-2 text-slate-500 sm:table-cell">{entry.resource}</td>
                <td className="px-1 py-2"><ResultBadge result={entry.result} /></td>
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length === 0 && (
        <p className="py-6 text-center text-sm text-slate-500">No audit log entries found</p>
      )}
      <p className="text-right text-sm text-slate-600">Showing {filtered.length} of {entries.length} entries · auto-refreshes every 30s</p>
    </div>
  );
}
