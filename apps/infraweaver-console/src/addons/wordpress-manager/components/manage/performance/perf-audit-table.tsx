"use client";

/**
 * Measured-speed zone (US-4) — the honest top of the funnel. It renders the FREE
 * Load-Time Audit's slowest real pages and, on the SAME row, the fix that our plan
 * would apply: a slow page with the cache off gets an "Enable Page Cache" button; a
 * slow page with the cache on gets "Purge this URL" (fusion: measurement → remedy).
 * Read-only + gate-free (the audit is a FREE feature); the fix buttons are enabled
 * only when the operator can act.
 */

import { useMemo, type ReactNode } from "react";
import { Gauge, RefreshCw, Timer, Zap } from "lucide-react";
import { DataTable, EmptyState, Pill, type Column } from "../../demo/manage/kit";
import { PanelError, Spinner } from "../../demo/manage/panel-shell";
import { BTN_SM } from "../../demo/manage/manage-ui";
import { usePerfAudit } from "../../../lib/manage/use-performance";
import type { AuditRow } from "../../../lib/manage/performance";
import { auditRowFixes } from "../../../lib/manage/performance-view";

interface PerfAuditTableProps {
  readonly site: string;
  /** Whether the IWSL page cache is on right now (decides the per-row fix). */
  readonly cacheEnabled: boolean;
  /** Whether page-cache actions are available (entitled + connector) — gates the fix buttons. */
  readonly canActOnCache: boolean;
  readonly busy: boolean;
  readonly onPurgeUrl: (path: string) => void;
  readonly onEnableCache: () => void;
}

function msTone(ms: number): "good" | "warn" | "bad" {
  if (ms >= 2000) return "bad";
  if (ms >= 800) return "warn";
  return "good";
}

export function PerfAuditTable({
  site,
  cacheEnabled,
  canActOnCache,
  busy,
  onPurgeUrl,
  onEnableCache,
}: PerfAuditTableProps): ReactNode {
  const audit = usePerfAudit(site);

  const columns = useMemo<Column<AuditRow>[]>(
    () => [
      {
        key: "path",
        header: "URL",
        primary: true,
        render: (r) => <span className="font-mono text-xs text-zinc-800 dark:text-zinc-200">{r.path}</span>,
      },
      {
        key: "avg_ms",
        header: "Avg",
        align: "right",
        render: (r) => {
          const t = msTone(r.avg_ms);
          return (
            <Pill tone={t === "bad" ? "critical" : t === "warn" ? "warn" : "good"}>{r.avg_ms.toLocaleString()} ms</Pill>
          );
        },
      },
      {
        key: "views",
        header: "Views",
        align: "right",
        render: (r) => <span className="tabular-nums text-xs text-zinc-500 dark:text-zinc-400">{r.count.toLocaleString()}</span>,
      },
      {
        key: "queries",
        header: "Queries",
        align: "right",
        render: (r) => <span className="tabular-nums text-xs text-zinc-500 dark:text-zinc-400">{r.avg_q}</span>,
      },
      {
        key: "fix",
        header: "Fix",
        render: (r) => {
          const fixes = auditRowFixes(r, { cacheEnabled });
          if (fixes.length === 0) return <span className="text-xs text-zinc-400">—</span>;
          return (
            <div className="flex flex-col items-start gap-1">
              {fixes.map((fix) => {
                if (fix.action === "enable-cache") {
                  return (
                    <button
                      key={fix.issue}
                      type="button"
                      className={BTN_SM}
                      title={fix.label}
                      disabled={!canActOnCache || busy}
                      onClick={onEnableCache}
                    >
                      {busy ? <Spinner /> : <Zap className="h-3.5 w-3.5" aria-hidden />} Enable cache
                    </button>
                  );
                }
                if (fix.action === "purge-url") {
                  return (
                    <button
                      key={fix.issue}
                      type="button"
                      className={BTN_SM}
                      title={fix.label}
                      disabled={!canActOnCache || busy}
                      onClick={() => onPurgeUrl(r.path)}
                    >
                      {busy ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />} Purge URL
                    </button>
                  );
                }
                return (
                  <span key={fix.issue} className="text-[11px] text-zinc-500 dark:text-zinc-400">
                    {fix.label}
                  </span>
                );
              })}
            </div>
          );
        },
      },
    ],
    [cacheEnabled, canActOnCache, busy, onPurgeUrl, onEnableCache],
  );

  if (audit.error) return <PanelError message={audit.error.message} onRetry={() => void audit.refetch()} />;
  if (audit.isPending) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-zinc-200 py-10 dark:border-zinc-800">
        <Spinner className="h-5 w-5 animate-spin text-sky-500" />
      </div>
    );
  }

  const data = audit.data;
  if (!data || !data.enabled) {
    return (
      <EmptyState
        icon={Timer}
        title="Load-Time Audit is off"
        body="Turn on the Load-Time Audit in the site's WordPress admin to measure real page speed."
      />
    );
  }
  if (data.items.length === 0) {
    return <EmptyState icon={Gauge} title="No measurements yet" body="The audit records real anonymous page views. Check back after some traffic." />;
  }

  return (
    <DataTable<AuditRow>
      columns={columns}
      rows={data.items}
      caption="Slowest measured pages with a prioritized fix per row"
      getRowKey={(r) => r.path}
      footer={
        <span className="tabular-nums">
          {data.total_samples.toLocaleString()} sample(s) across {data.paths_tracked} URL(s) · site avg {data.avg_ms.toLocaleString()} ms
        </span>
      }
    />
  );
}
