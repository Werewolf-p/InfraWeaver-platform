"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Database, Loader2, Search } from "lucide-react";
import { cn } from "@/lib/utils";

// Loki-backed historical log search. Unlike the live pod viewer (kubectl-style,
// one running pod), this queries the in-cluster Loki that promtail ships every
// pod's stdout to — so it spans a whole namespace and survives pod restarts.

interface LogRow {
  ts: string;
  line: string;
  pod: string;
  container: string;
}

interface SearchResponse {
  available: boolean;
  count?: number;
  truncated?: boolean;
  rows?: LogRow[];
  error?: string;
}

const HOUR_OPTIONS = [
  { label: "1h", value: 1 },
  { label: "6h", value: 6 },
  { label: "24h", value: 24 },
  { label: "7d", value: 168 },
];

function lineLevelClass(line: string): string {
  const value = line.toLowerCase();
  if (value.includes("error") || value.includes("fatal") || value.includes("critical")) return "text-red-300";
  if (value.includes("warn")) return "text-amber-300";
  if (value.includes("debug") || value.includes("trace")) return "text-slate-500";
  return "text-slate-200";
}

/** Nanosecond-epoch string → local HH:MM:SS.mmm. */
function formatTs(nanos: string): string {
  const ms = Number(nanos.slice(0, 13));
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  return date.toLocaleTimeString([], { hour12: false }) + "." + String(date.getMilliseconds()).padStart(3, "0");
}

export function LogsView() {
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [namespace, setNamespace] = useState("");
  const [query, setQuery] = useState("");
  const [hours, setHours] = useState(1);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error" | "done">("idle");
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/logs/search");
        const body = (await res.json()) as { namespaces?: string[] };
        if (!cancelled) {
          const list = body.namespaces ?? [];
          setNamespaces(list);
          setNamespace((current) => current || list[0] || "");
        }
      } catch {
        if (!cancelled) setNamespaces([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runSearch = useCallback(async () => {
    if (!namespace) return;
    setStatus("loading");
    setError("");
    try {
      const params = new URLSearchParams({ namespace, hours: String(hours) });
      if (query.trim()) params.set("q", query.trim());
      const res = await fetch(`/api/logs/search?${params.toString()}`);
      const body = (await res.json()) as SearchResponse;
      if (!res.ok || body.available === false) {
        throw new Error(body.error ?? `Search failed (${res.status})`);
      }
      setRows(body.rows ?? []);
      setTruncated(Boolean(body.truncated));
      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, [namespace, hours, query]);

  const hasResults = rows.length > 0;
  const summary = useMemo(() => {
    if (status === "done") return `${rows.length}${truncated ? "+" : ""} lines`;
    return "";
  }, [status, rows.length, truncated]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex items-start gap-3 rounded-2xl border border-indigo-500/20 bg-indigo-500/5 px-4 py-3 text-sm text-indigo-200/90">
        <Database className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <p>
          Historical logs from the in-cluster <span className="font-semibold">Loki</span> store — spans an entire
          namespace and survives pod restarts, unlike the single live-pod viewer under Workloads.
        </p>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch();
        }}
        className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-slate-900/70 p-4"
      >
        <select
          value={namespace}
          onChange={(event) => setNamespace(event.target.value)}
          aria-label="Namespace"
          className="rounded-lg border border-white/10 bg-slate-950 px-3 py-2 text-sm text-white outline-none focus:border-indigo-500/50"
        >
          {namespaces.length === 0 ? <option value="">No namespaces</option> : null}
          {namespaces.map((ns) => (
            <option key={ns} value={ns}>
              {ns}
            </option>
          ))}
        </select>

        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Contains text (optional)…"
            className="w-full rounded-lg border border-white/10 bg-slate-950 py-2 pl-9 pr-3 text-sm text-white placeholder:text-slate-500 outline-none focus:border-indigo-500/50"
          />
        </div>

        <div role="group" aria-label="Time range" className="flex items-center gap-1 rounded-lg border border-white/10 bg-slate-950/70 p-1">
          {HOUR_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={hours === option.value}
              onClick={() => setHours(option.value)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition",
                hours === option.value ? "bg-white/10 text-white" : "text-slate-400 hover:bg-white/5 hover:text-white",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        <button
          type="submit"
          disabled={!namespace || status === "loading"}
          className="inline-flex items-center gap-2 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-sm text-indigo-300 transition hover:bg-indigo-500/20 disabled:opacity-50"
        >
          {status === "loading" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          Search
        </button>

        {summary ? <span className="text-xs text-slate-500">{summary}</span> : null}
      </form>

      {status === "error" ? (
        <div className="flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      <div className="min-h-[420px] flex-1 overflow-auto rounded-2xl border border-white/10 bg-slate-950 p-4 font-mono text-xs leading-relaxed">
        {!hasResults ? (
          <div className="flex h-full items-center justify-center text-slate-500">
            {status === "done" ? "No log lines matched." : "Choose a namespace and search to load history."}
          </div>
        ) : (
          <div className="space-y-1">
            {rows.map((row, index) => (
              <div key={`${row.ts}-${index}`} className="group flex items-start gap-3 rounded-lg px-2 py-1 hover:bg-white/5">
                <span className="w-24 shrink-0 text-slate-600">{formatTs(row.ts)}</span>
                <span className="w-40 shrink-0 truncate text-indigo-300/70" title={`${row.pod}${row.container ? ` · ${row.container}` : ""}`}>
                  {row.pod}
                </span>
                <span className={cn("min-w-0 flex-1 whitespace-pre-wrap break-words", lineLevelClass(row.line))}>{row.line}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
