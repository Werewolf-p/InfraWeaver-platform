"use client";

/**
 * The redirect manager sub-section — the full table (source, target, type, match,
 * hits, auto badge) with bulk delete via the shared kit (`SelectableDataTable` +
 * `BulkActionBar`), create, 404-logging + auto-slug toggles, and JSON import /
 * export. Every mutation funnels through a signed method whose gauntlet + cycle
 * detection + reserved-path checks stay in the connector — the console never
 * re-implements them, so refusal tokens surface verbatim.
 */

import { useMemo, useState, type JSX } from "react";
import { Plus, ArrowRightLeft, Download, Upload } from "lucide-react";
import { toast } from "@/lib/notify";
import { SectionCard } from "../../demo/widgets";
import { EmptyState, Pill } from "../../demo/manage/kit";
import { BTN, BTN_PRIMARY, INPUT } from "../../demo/manage/manage-ui";
import type { Column } from "../../demo/manage/kit/data-table";
import { SelectableDataTable, BulkActionBar, type BulkActionMeta } from "../kit";
import { clearSelection, type IdSelection } from "../../../lib/manage/selection";
import { useRedirects, type SiteHealthActions } from "../../../lib/manage/use-site-health";
import { MAX_IMPORT_RULES, type RedirectImportParams, type RedirectRule } from "../../../lib/manage/site-health";
import { redirectReasonLabel } from "./redirect-form";
import { LockedCard } from "./redirect-form";

const DELETE_ACTIONS: readonly BulkActionMeta[] = [
  {
    id: "delete",
    label: "Delete",
    icon: ArrowRightLeft,
    danger: true,
    confirm: true,
    confirmTitle: (n) => `Delete ${n} redirect${n === 1 ? "" : "s"}?`,
    description: "The selected redirect rules will be removed. This cannot be undone.",
  },
];

/** Best-effort JSON export of the current rules (source/target/type/match only). */
function exportRules(rules: readonly RedirectRule[]): void {
  const rows = rules.map((r) => ({ source: r.source, target: r.target, type: r.type, match: r.match }));
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "redirects.json";
  a.click();
  URL.revokeObjectURL(url);
}

/** Parse an import textarea into bounded import params, or throw a friendly error. */
function parseImport(text: string): RedirectImportParams {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That isn't valid JSON — paste an array of { source, target, type } rows.");
  }
  if (!Array.isArray(raw)) throw new Error("Expected a JSON array of redirect rows.");
  if (raw.length === 0) throw new Error("No rows to import.");
  if (raw.length > MAX_IMPORT_RULES) throw new Error(`At most ${MAX_IMPORT_RULES} rows per import.`);
  const rules = raw.map((row) => {
    const r = row as Record<string, unknown>;
    const type = Number(r.type);
    return {
      source: String(r.source ?? ""),
      target: String(r.target ?? ""),
      type: (type === 302 ? 302 : 301) as 301 | 302,
      ...(typeof r.match === "string" ? { match: r.match as "exact" | "prefix" | "regex" } : {}),
    };
  });
  return { rules } as RedirectImportParams;
}

export interface RedirectsManagerProps {
  readonly site: string;
  readonly enabled: boolean;
  readonly locked: boolean;
  readonly actions: SiteHealthActions;
  readonly onNewRedirect: () => void;
}

export function RedirectsManager({ site, enabled, locked, actions, onNewRedirect }: RedirectsManagerProps): JSX.Element {
  const query = useRedirects(site, enabled && !locked);
  const [selection, setSelection] = useState<IdSelection>(() => clearSelection());
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");

  const data = query.data;
  const rules = useMemo<readonly RedirectRule[]>(() => (data && !data.locked ? data.rules ?? [] : []), [data]);

  const columns: readonly Column<RedirectRule>[] = [
    {
      key: "source",
      header: "Source",
      primary: true,
      render: (r) => (
        <span className="flex items-center gap-2 font-mono text-[11px]">
          {r.source}
          {r.auto ? <Pill tone="neutral">auto</Pill> : null}
        </span>
      ),
    },
    {
      key: "target",
      header: "Target",
      render: (r) => (
        <span className="flex items-center gap-2 font-mono text-[11px]">
          {r.target}
          {r.external ? <Pill tone="warn">external</Pill> : null}
        </span>
      ),
    },
    { key: "type", header: "Type", render: (r) => <span className="tabular-nums">{r.type}</span> },
    { key: "match", header: "Match", render: (r) => <Pill tone="neutral">{r.match}</Pill> },
    { key: "hits", header: "Hits", align: "right", render: (r) => <span className="tabular-nums">{r.hits}</span> },
  ];

  async function runDelete(_actionId: string, id: string): Promise<{ ok: boolean; message?: string }> {
    try {
      const res = await actions.deleteRedirect(id);
      return res.ok ? { ok: true } : { ok: false, message: redirectReasonLabel(res.reason) };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Delete failed" };
    }
  }

  async function runImport(): Promise<void> {
    let params: RedirectImportParams;
    try {
      params = parseImport(importText);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Invalid import");
      return;
    }
    const result = await actions.importRedirects(params);
    const okCount = result.results.filter((r) => r.ok).length;
    const failed = result.results.length - okCount;
    if (failed === 0) toast.success(`Imported ${okCount} redirect${okCount === 1 ? "" : "s"}.`);
    else toast.warning(`Imported ${okCount}, ${failed} refused (duplicates / invalid).`);
    setImportOpen(false);
    setImportText("");
  }

  const headerAction = (
    <div className="flex items-center gap-2">
      <button type="button" className={BTN} onClick={() => exportRules(rules)} disabled={locked || rules.length === 0}>
        <Download className="h-3.5 w-3.5" aria-hidden /> Export
      </button>
      <button type="button" className={BTN} onClick={() => setImportOpen((v) => !v)} disabled={locked}>
        <Upload className="h-3.5 w-3.5" aria-hidden /> Import
      </button>
      <button type="button" className={BTN_PRIMARY} onClick={onNewRedirect} disabled={locked}>
        <Plus className="h-3.5 w-3.5" aria-hidden /> New redirect
      </button>
    </div>
  );

  return (
    <SectionCard
      title="Redirects"
      description="301/302 rules with hits, match kind and slug-change auto-rules — the manager where the 404 and broken-link evidence lives."
      icon={ArrowRightLeft}
      action={locked ? undefined : headerAction}
    >
      {locked ? (
        <LockedCard title="Redirects — included in Pro" body="Upgrade to manage 301/302 redirects, prefix rules and slug-change safety from here." />
      ) : (
        <>
          <TogglesRow data={data} actions={actions} />

          {importOpen ? (
            <div className="mb-4 grid gap-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
              <label htmlFor="sh-import" className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
                Paste redirect JSON (array of {"{ source, target, type }"}, ≤ {MAX_IMPORT_RULES} rows)
              </label>
              <textarea
                id="sh-import"
                className={`${INPUT} h-28 font-mono text-[11px]`}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder='[{ "source": "/old", "target": "/new", "type": 301 }]'
              />
              <div className="flex justify-end gap-2">
                <button type="button" className={BTN} onClick={() => setImportOpen(false)}>
                  Cancel
                </button>
                <button type="button" className={BTN_PRIMARY} onClick={() => void runImport()} disabled={actions.pending}>
                  Import rules
                </button>
              </div>
            </div>
          ) : null}

          <SelectableDataTable
            columns={columns}
            rows={rules}
            caption="Redirect rules"
            getRowId={(r) => r.id}
            rowLabel={(r) => `Select redirect ${r.source}`}
            selection={selection}
            onSelectionChange={setSelection}
            empty={
              <EmptyState
                icon={ArrowRightLeft}
                title={query.isLoading ? "Loading redirects…" : "No redirects yet"}
                body="Create a redirect, or fix a broken link / 404 to add one automatically."
              />
            }
          />

          <BulkActionBar
            count={selection.size}
            ids={[...selection]}
            actions={DELETE_ACTIONS}
            runItem={runDelete}
            onClear={() => setSelection(clearSelection())}
            onComplete={() => setSelection(clearSelection())}
            itemLabel={(id) => id}
          />
        </>
      )}
    </SectionCard>
  );
}

/** The 404-logging + auto-slug toggle row. */
function TogglesRow({
  data,
  actions,
}: {
  data: ReturnType<typeof useRedirects>["data"];
  actions: SiteHealthActions;
}): JSX.Element | null {
  if (!data || data.locked) return null;
  const logEnabled = data.log_enabled === true;
  const autoSlug = data.auto_slug === true;
  return (
    <div className="mb-4 flex flex-wrap gap-4 rounded-xl border border-zinc-200 p-3 text-sm dark:border-zinc-800">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={logEnabled}
          disabled={actions.pending}
          onChange={(e) => void actions.setToggles({ log_404: e.target.checked })}
        />
        Log 404s (feeds the suggestions below)
      </label>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={autoSlug}
          disabled={actions.pending}
          onChange={(e) => void actions.setToggles({ auto_slug: e.target.checked })}
        />
        Auto-redirect on slug change
      </label>
    </div>
  );
}
