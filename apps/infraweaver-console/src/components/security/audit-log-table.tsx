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
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 flex-1 min-w-[140px]">
          <Filter className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
          <input
            type="text"
            placeholder="Filter by user..."
            value={userFilter}
            onChange={e => setUserFilter(e.target.value)}
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
          />
        </div>
        <input
          type="text"
          placeholder="Filter by action..."
          value={actionFilter}
          onChange={e => setActionFilter(e.target.value)}
          className="flex-1 min-w-[140px] bg-white/5 border border-white/10 rounded-lg px-2 py-1 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
        />
        <button
          onClick={exportCSV}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 text-xs text-slate-300 hover:text-white hover:bg-white/10 transition-colors"
        >
          <Download className="w-3 h-3" />
          Export CSV
        </button>
      </div>
      
      {/* Table */}
      <div className="overflow-x-auto -mx-1">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-slate-500 border-b border-white/5">
              <th className="text-left pb-2 font-medium px-1">Time</th>
              <th className="text-left pb-2 font-medium px-1">User</th>
              <th className="text-left pb-2 font-medium px-1">Action</th>
              <th className="text-left pb-2 font-medium px-1 hidden sm:table-cell">Resource</th>
              <th className="text-left pb-2 font-medium px-1">Result</th>
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
                <td className="py-2 px-1 text-slate-400 whitespace-nowrap">{timeAgo(entry.timestamp)}</td>
                <td className="py-2 px-1 text-slate-300 max-w-[120px] truncate">{entry.user}</td>
                <td className="py-2 px-1 text-slate-400 font-mono">{entry.action}</td>
                <td className="py-2 px-1 text-slate-500 max-w-[140px] truncate hidden sm:table-cell">{entry.resource}</td>
                <td className="py-2 px-1"><ResultBadge result={entry.result} /></td>
              </motion.tr>
            ))}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <p className="text-sm text-slate-500 text-center py-6">No audit log entries found</p>
        )}
      </div>
      <p className="text-xs text-slate-600 text-right">Showing {filtered.length} of {entries.length} entries · auto-refreshes every 30s</p>
    </div>
  );
}
