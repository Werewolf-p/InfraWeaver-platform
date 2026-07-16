"use client";

import { useMemo, useState } from "react";
import { History, Download, ShieldAlert } from "lucide-react";
import { FilterSelect, PageScaffold, SearchInput } from "@/components/ui";
import { useAuditQuery, buildAuditQueryString, type AuditQueryParams } from "@/hooks/use-audit-query";
import type { AuditRecord } from "@/lib/audit/types";
import { cn, timeAgo } from "@/lib/utils";

const PAGE_STEP = 50;
const MAX_LIMIT = 500;

const CATEGORY_OPTIONS = [
  { value: "all", label: "All categories" },
  { value: "user", label: "User" },
  { value: "rbac", label: "RBAC" },
  { value: "secret", label: "Secret" },
  { value: "cluster", label: "Cluster" },
  { value: "gitops", label: "GitOps" },
  { value: "auth", label: "Auth" },
  { value: "app", label: "App" },
  { value: "other", label: "Other" },
];

const SEVERITY_OPTIONS = [
  { value: "all", label: "All severities" },
  { value: "critical", label: "Critical" },
  { value: "warning", label: "Warning" },
  { value: "notice", label: "Notice" },
  { value: "info", label: "Info" },
];

const RESULT_OPTIONS = [
  { value: "all", label: "All results" },
  { value: "success", label: "Success" },
  { value: "failure", label: "Failure" },
];

const SEVERITY_STYLES: Record<string, string> = {
  critical: "bg-red-500/20 text-red-400 border-red-500/30",
  warning: "bg-orange-500/20 text-orange-400 border-orange-500/30",
  notice: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  info: "bg-slate-500/20 text-slate-500 dark:text-slate-400 border-slate-500/30",
};

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span className={cn("rounded-full border px-2 py-0.5 text-xs font-semibold", SEVERITY_STYLES[severity] ?? SEVERITY_STYLES.info)}>
      {severity}
    </span>
  );
}

function ResultBadge({ result }: { result: "success" | "failure" }) {
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-xs font-semibold",
        result === "success"
          ? "bg-green-500/20 text-green-400 border-green-500/30"
          : "bg-red-500/20 text-red-400 border-red-500/30",
      )}
    >
      {result === "success" ? "OK" : "FAIL"}
    </span>
  );
}

export default function AuditPage() {
  const [q, setQ] = useState("");
  const [user, setUser] = useState("");
  const [category, setCategory] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [result, setResult] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [limit, setLimit] = useState(PAGE_STEP);

  // Any filter change resets paging back to the first page.
  const resetPaging = () => setLimit(PAGE_STEP);

  const params: AuditQueryParams = useMemo(
    () => ({
      q: q || undefined,
      user: user || undefined,
      category,
      severity,
      result,
      from: from ? new Date(from).toISOString() : undefined,
      to: to ? new Date(to).toISOString() : undefined,
      limit,
    }),
    [q, user, category, severity, result, from, to, limit],
  );

  const { data, isLoading, isError, isFetching, refetch } = useAuditQuery(params);
  const entries: AuditRecord[] = data?.entries ?? [];
  const total = data?.total ?? 0;
  const hasMore = entries.length < total && limit < MAX_LIMIT;

  const exportHref = `/api/audit${buildAuditQueryString({ ...params, limit: undefined, format: "csv" } as AuditQueryParams & { format: string })}`;

  return (
    <PageScaffold
      icon={History}
      title="Audit Log"
      subtitle="Durable, tamper-evident record of every platform mutation"
      description="Search and filter the console audit trail by user, action, category, severity, result, and date."
      isFetching={isFetching}
      loading={isLoading}
      isError={isError}
      errorMessage="Failed to load the audit trail"
      onRetry={() => void refetch()}
      actions={
        <a
          href={exportHref}
          className="inline-flex min-h-[44px] items-center gap-2 rounded-2xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-4 text-sm font-medium text-slate-700 dark:text-slate-300 transition-colors hover:bg-gray-200 dark:hover:bg-white/10 hover:text-gray-900 dark:hover:text-white"
        >
          <Download className="h-4 w-4" />
          Export CSV
        </a>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <SearchInput placeholder="Search action, user, detail…" value={q} onChange={(v) => { setQ(v); resetPaging(); }} />
          <SearchInput placeholder="Filter by user" value={user} onChange={(v) => { setUser(v); resetPaging(); }} />
          <FilterSelect label="Category" value={category} options={CATEGORY_OPTIONS} onChange={(v) => { setCategory(v); resetPaging(); }} />
          <FilterSelect label="Severity" value={severity} options={SEVERITY_OPTIONS} onChange={(v) => { setSeverity(v); resetPaging(); }} />
          <FilterSelect label="Result" value={result} options={RESULT_OPTIONS} onChange={(v) => { setResult(v); resetPaging(); }} />
          <label className="flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 dark:border-[#333] dark:bg-[#0f0f0f] dark:text-[#f2f2f2]">
            <span className="shrink-0 text-slate-400 dark:text-[#9a9a9a]">From</span>
            <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); resetPaging(); }} aria-label="From date" className="w-full bg-transparent outline-none" />
          </label>
          <label className="flex min-h-[44px] items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 dark:border-[#333] dark:bg-[#0f0f0f] dark:text-[#f2f2f2]">
            <span className="shrink-0 text-slate-400 dark:text-[#9a9a9a]">To</span>
            <input type="date" value={to} onChange={(e) => { setTo(e.target.value); resetPaging(); }} aria-label="To date" className="w-full bg-transparent outline-none" />
          </label>
        </div>

        <div className="flex items-center justify-between text-sm text-slate-500">
          <span>Showing {entries.length} of {total} matching entries</span>
        </div>

        {entries.length === 0 ? (
          <div className="py-12 text-center">
            <ShieldAlert aria-hidden="true" className="mx-auto mb-2 h-8 w-8 text-slate-500" />
            <p className="text-sm text-slate-500">No audit entries match these filters.</p>
          </div>
        ) : (
          <div className="hidden overflow-x-auto -mx-1 sm:block">
            <table className="w-full text-sm">
              <caption className="sr-only">Audit trail entries</caption>
              <thead>
                <tr className="border-b border-gray-200 dark:border-white/5 text-slate-500">
                  <th scope="col" className="px-1 pb-2 text-left font-medium">Time</th>
                  <th scope="col" className="px-1 pb-2 text-left font-medium">Severity</th>
                  <th scope="col" className="px-1 pb-2 text-left font-medium">Category</th>
                  <th scope="col" className="px-1 pb-2 text-left font-medium">User</th>
                  <th scope="col" className="px-1 pb-2 text-left font-medium">Action</th>
                  <th scope="col" className="hidden px-1 pb-2 text-left font-medium md:table-cell">Target</th>
                  <th scope="col" className="px-1 pb-2 text-left font-medium">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-white/5">
                {entries.map((entry) => (
                  <tr key={entry.seq} className={cn("transition-colors", entry.result === "failure" && "bg-red-500/5")}>
                    <td className="whitespace-nowrap px-1 py-2 text-slate-500 dark:text-slate-400">{timeAgo(new Date(entry.timestamp))}</td>
                    <td className="px-1 py-2"><SeverityBadge severity={entry.severity} /></td>
                    <td className="px-1 py-2 text-slate-500 dark:text-slate-400">{entry.category}</td>
                    <td className="max-w-[140px] truncate px-1 py-2 text-slate-700 dark:text-slate-300">{entry.user}</td>
                    <td className="px-1 py-2 font-mono text-slate-500 dark:text-slate-400">{entry.action}</td>
                    <td className="hidden max-w-[160px] truncate px-1 py-2 text-slate-500 md:table-cell">{entry.target ?? "—"}</td>
                    <td className="px-1 py-2"><ResultBadge result={entry.result} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Mobile cards */}
        {entries.length > 0 && (
          <div className="space-y-3 sm:hidden">
            {entries.map((entry) => (
              <div
                key={entry.seq}
                className={cn(
                  "rounded-2xl border p-4",
                  entry.result === "failure" ? "border-red-500/20 bg-red-500/5" : "border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-sm text-slate-700 dark:text-slate-300">{entry.action}</p>
                    <p className="mt-1 text-sm text-slate-500">{entry.user}</p>
                  </div>
                  <SeverityBadge severity={entry.severity} />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span className="rounded-full border border-gray-200 dark:border-white/10 px-2 py-0.5">{entry.category}</span>
                  {entry.target ? <span className="truncate">{entry.target}</span> : null}
                  <span className="ml-auto">{timeAgo(new Date(entry.timestamp))}</span>
                  <ResultBadge result={entry.result} />
                </div>
              </div>
            ))}
          </div>
        )}

        {hasMore && (
          <div className="flex justify-center pt-2">
            <button
              onClick={() => setLimit((current) => Math.min(current + PAGE_STEP, MAX_LIMIT))}
              className="inline-flex min-h-[44px] items-center rounded-2xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-6 text-sm font-medium text-slate-700 dark:text-slate-300 transition-colors hover:bg-gray-200 dark:hover:bg-white/10"
            >
              Load more
            </button>
          </div>
        )}
      </div>
    </PageScaffold>
  );
}
