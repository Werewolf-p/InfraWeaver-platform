"use client";

/**
 * Zone 2 — the cleanup grid. PREVIEW-BEFORE-DELETE is the whole point: tick
 * categories, run a dry-run preview (`db.cleanup { dry_run: true }` — zero
 * DELETEs, engine-verified) that renders "would remove N" inline, and only then
 * enable a Delete labelled with the previewed total, behind a confirm that
 * restates the per-category cap. The delete wire call carries an EXPLICIT
 * `dry_run: false` — the connector treats anything else as a preview.
 *
 * "Safe optimize" (S3) is the dedicated, non-row-deleting path for the
 * `optimize_tables` cleaner, driven by the reclaimable-overhead estimate. The
 * Advanced control (S4) can only ever LOWER the per-category cap.
 */

import { useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Eye, Sparkles, Trash2 } from "lucide-react";
import { toast } from "@/lib/notify";
import { SectionCard } from "../../demo/widgets";
import { Spinner } from "../../demo/manage/panel-shell";
import { BTN, BTN_DANGER, BTN_PRIMARY, ConfirmDialog } from "../../demo/manage/manage-ui";
import { Pill } from "../../demo/manage/kit/pill";
import { cleanupDatabase } from "../../../lib/manage/use-database";
import type { DbCaps, DbCategoryCount } from "../../../lib/manage/database";
import { fmt } from "./db-format";

export interface DbCleanupGridProps {
  readonly site: string;
  /** Row-deletable categories (the cockpit filters out `optimize_tables`). */
  readonly categories: readonly DbCategoryCount[];
  readonly caps: DbCaps;
  /** Reclaimable overhead for the Safe optimize estimate; null = unknown. */
  readonly overheadMb: number | null;
  readonly onChanged: () => void;
}

/** The selection + cap signature a preview is valid for; a change invalidates it. */
function signatureOf(ids: readonly string[], maxRows: number): string {
  return [...ids].sort().join(",") + "|" + maxRows;
}

export function DbCleanupGrid({ site, categories, caps, overheadMb, onChanged }: DbCleanupGridProps): ReactNode {
  const hardCap = caps.max_rows;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [maxRows, setMaxRows] = useState<number>(hardCap);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [previewCounts, setPreviewCounts] = useState<Map<string, number> | null>(null);
  const [previewSig, setPreviewSig] = useState<string | null>(null);
  const [previewTotal, setPreviewTotal] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [optimizeOpen, setOptimizeOpen] = useState(false);
  const [optimizing, setOptimizing] = useState(false);

  const selectedIds = useMemo(() => [...selected], [selected]);
  const effectiveCap = Math.max(1, Math.min(maxRows, hardCap));
  const currentSig = signatureOf(selectedIds, maxRows);
  const previewValid = previewSig !== null && previewSig === currentSig;

  // A selection or cap change invalidates the standing preview (its counts and
  // total no longer describe what Delete would do — preview-before-delete holds).
  function invalidatePreview(): void {
    setPreviewCounts(null);
    setPreviewSig(null);
    setPreviewTotal(0);
  }

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    invalidatePreview();
  }

  function changeMaxRows(value: number): void {
    const clamped = Number.isFinite(value) ? Math.max(1, Math.min(Math.round(value), hardCap)) : hardCap;
    setMaxRows(clamped);
    invalidatePreview();
  }

  async function runPreview(): Promise<void> {
    if (selectedIds.length === 0) return;
    setPreviewing(true);
    try {
      const res = await cleanupDatabase(site, { categories: selectedIds, dry_run: true, max_rows: maxRows });
      if (res.ok === false) {
        toast.error(`Preview refused (${res.reason ?? "unavailable"})`);
        return;
      }
      const counts = new Map<string, number>();
      for (const row of res.cleaners) counts.set(row.id, "count" in row ? row.count : 0);
      setPreviewCounts(counts);
      setPreviewTotal(res.total);
      setPreviewSig(currentSig);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not preview the cleanup");
    } finally {
      setPreviewing(false);
    }
  }

  async function runDelete(): Promise<void> {
    setDeleting(true);
    try {
      const res = await cleanupDatabase(site, { categories: selectedIds, dry_run: false, max_rows: maxRows });
      if (res.ok === false) {
        toast.error(`Cleanup refused (${res.reason ?? "unavailable"})`);
        return;
      }
      const capped = res.cleaners.some((c) => ("deleted" in c ? c.deleted : 0) >= res.cap);
      toast.success(
        capped
          ? `Removed ${fmt(res.total)} rows — some categories hit the ${fmt(res.cap)}-row cap; run again to continue.`
          : `Removed ${fmt(res.total)} rows.`,
      );
      setSelected(new Set());
      invalidatePreview();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cleanup failed");
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  }

  async function runOptimize(): Promise<void> {
    setOptimizing(true);
    try {
      const res = await cleanupDatabase(site, { categories: ["optimize_tables"], dry_run: false });
      if (res.ok === false) {
        toast.error(`Optimize refused (${res.reason ?? "unavailable"})`);
        return;
      }
      toast.success("Tables optimized — reclaimable overhead has been freed.");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Optimize failed");
    } finally {
      setOptimizing(false);
      setOptimizeOpen(false);
    }
  }

  const busy = previewing || deleting || optimizing;
  const optimizeLabel =
    overheadMb !== null && overheadMb > 0 ? `Safe optimize (~${overheadMb} MB reclaimable)` : "Safe optimize";

  return (
    <SectionCard
      title="Clean up"
      description={`Preview every category before anything is removed. At most ${fmt(hardCap)} rows per category per run — tables are never dropped.`}
      icon={Trash2}
    >
      <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {categories.map((cat) => {
          const would = previewValid ? previewCounts?.get(cat.id) : undefined;
          return (
            <li key={cat.id} className="flex items-center justify-between gap-3 py-2.5">
              <label className="flex min-w-0 items-center gap-2.5">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-zinc-300 text-sky-600 focus:ring-sky-500 dark:border-zinc-600"
                  checked={selected.has(cat.id)}
                  onChange={() => toggle(cat.id)}
                  disabled={busy}
                />
                <span className="truncate text-sm text-zinc-800 dark:text-zinc-200">{cat.label}</span>
              </label>
              <span className="flex shrink-0 items-center gap-2 text-sm tabular-nums text-zinc-500 dark:text-zinc-400">
                {would !== undefined ? <Pill tone={would > 0 ? "warn" : "neutral"}>would remove {fmt(would)}</Pill> : null}
                <span>{fmt(cat.count)} rows</span>
              </span>
            </li>
          );
        })}
        {categories.length === 0 ? (
          <li className="py-4 text-sm text-zinc-500 dark:text-zinc-400">No cleanup categories reported for this site.</li>
        ) : null}
      </ul>

      <div className="mt-3">
        <button type="button" className="text-xs font-medium text-sky-600 hover:underline dark:text-sky-400" onClick={() => setAdvancedOpen((v) => !v)}>
          {advancedOpen ? "Hide advanced" : "Advanced — lower the per-run cap"}
        </button>
        {advancedOpen ? (
          <div className="mt-2 flex items-center gap-2">
            <label htmlFor="db-max-rows" className="text-xs text-zinc-600 dark:text-zinc-400">
              Rows per category, per run
            </label>
            <input
              id="db-max-rows"
              type="number"
              min={1}
              max={hardCap}
              value={maxRows}
              onChange={(e) => changeMaxRows(Number(e.target.value))}
              disabled={busy}
              className="w-24 rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm tabular-nums text-zinc-900 dark:border-zinc-700 dark:bg-zinc-950/60 dark:text-zinc-100"
            />
            <span className="text-xs text-zinc-500 dark:text-zinc-400">capped at {fmt(hardCap)}</span>
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" className={BTN} disabled={busy || selectedIds.length === 0} onClick={() => void runPreview()}>
          {previewing ? <Spinner /> : <Eye className="h-4 w-4" aria-hidden />} Preview cleanup
        </button>
        <button
          type="button"
          className={BTN_DANGER}
          disabled={busy || !previewValid || previewTotal === 0}
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 className="h-4 w-4" aria-hidden /> Delete {previewValid ? fmt(previewTotal) : "0"} rows
        </button>
        {!previewValid && selectedIds.length > 0 ? (
          <span className="inline-flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> Preview to enable delete
          </span>
        ) : null}
      </div>

      <div className="mt-5 border-t border-zinc-100 pt-4 dark:border-zinc-800">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Safe optimize</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Reclaims table overhead on the 12 core tables only — never DROP/TRUNCATE/ALTER. Each table locks briefly.
            </p>
          </div>
          <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => setOptimizeOpen(true)}>
            {optimizing ? <Spinner /> : <Sparkles className="h-4 w-4" aria-hidden />} {optimizeLabel}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={() => void runDelete()}
        title={`Delete ${fmt(previewTotal)} rows?`}
        description={`Removes the previewed rows across ${selectedIds.length} categor${selectedIds.length === 1 ? "y" : "ies"}. At most ${fmt(effectiveCap)} rows per category this run — tables are never dropped. Run again to continue if a category exceeds the cap.`}
        confirmLabel={`Delete ${fmt(previewTotal)} rows`}
        tone="danger"
        pending={deleting}
      />

      <ConfirmDialog
        open={optimizeOpen}
        onClose={() => setOptimizeOpen(false)}
        onConfirm={() => void runOptimize()}
        title="Optimize core tables?"
        description="Runs OPTIMIZE TABLE across the 12 core WordPress tables to reclaim overhead. Each table is locked briefly, so prefer a quiet moment. Never DROP/TRUNCATE/ALTER."
        confirmLabel="Optimize tables"
        tone="neutral"
        pending={optimizing}
      />
    </SectionCard>
  );
}
