"use client";

/**
 * The actionable heart of the SEO cockpit — where audit numbers become verbs.
 *
 *  - `SeoAuditMap`: runs the console-side bounded audit (signed `seo.audit.run`,
 *    gated `seo_audit`/Pro) and renders the per-page issue list. Each page expands
 *    to a drawer of labelled issues plus a QUICK-FIX form (title / meta description /
 *    focus keyphrase / noindex) that writes one allow-listed `_iwseo_*` field via the
 *    signed `seo.fix.apply` (gated `seo_suite`/Ultimate) and optimistically re-audits.
 *  - `SeoAltBackfill`: the "fill missing alt text" door — a dry-run PREVIEW then a
 *    batched apply that loops `seo.alt.backfill` (never clobbers author alt) until
 *    `remaining=0`, with a visible progress line. Same signed method the media
 *    explorer's bulk bar will call — one engine, two doors.
 *
 * Every write goes through the dedicated signed route (`use-seo.ts`); nothing here
 * introduces an unsigned endpoint. Locked replies render an upsell inline.
 */

import { useCallback, useState } from "react";
import { ChevronDown, ChevronRight, ImageOff, Loader2, PlayCircle, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import { Pill } from "../../demo/manage/kit/pill";
import { EmptyState } from "../../demo/manage/kit/empty-state";
import { BTN_PRIMARY, BTN_SM, INPUT } from "../../demo/manage/manage-ui";
import { useSiteEntitlements } from "../../../lib/manage/use-site-entitlements";
import {
  applySeoFix,
  backfillSeoAlt as backfillSeoAltReq,
  runSeoAudit as runSeoAuditReq,
} from "../../../lib/manage/use-seo";
import {
  AUDIT_MAX_ITEMS,
  auditIssueLabel,
  isSeoLocked,
  type SeoAuditItem,
  type SeoAuditSummary,
  type SeoFixField,
} from "../../../lib/manage/seo";

// ── the console-run audit map ───────────────────────────────────────────────────

export function SeoAuditMap({ site }: { site: string }) {
  const [summary, setSummary] = useState<SeoAuditSummary | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const result = await runSeoAuditReq(site, { limit: AUDIT_MAX_ITEMS });
      if (isSeoLocked(result)) {
        setError("Meta Audit is not available on this site’s current plan.");
        return;
      }
      setSummary(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Audit failed";
      setError(message);
      toast.error(message);
    } finally {
      setRunning(false);
    }
  }, [site]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">On-page audit</h3>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Scan up to {AUDIT_MAX_ITEMS} published posts and pages for missing titles, descriptions, thin content and more.
          </p>
        </div>
        <button type="button" className={cn(BTN_PRIMARY)} onClick={run} disabled={running}>
          {running ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <PlayCircle className="h-4 w-4" aria-hidden />}
          {summary ? "Re-run audit" : "Run audit"}
        </button>
      </div>

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</div>
      ) : null}

      {summary ? <AuditResult site={site} summary={summary} onReaudit={run} /> : null}
      {!summary && !error && !running ? (
        <EmptyState icon={PlayCircle} title="No audit yet" body="Run the audit to see per-page issues and fix them here." />
      ) : null}
    </div>
  );
}

function AuditResult({ site, summary, onReaudit }: { site: string; summary: SeoAuditSummary; onReaudit: () => void }) {
  const withIssues = summary.items.filter((item) => item.issues.length > 0);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
        <Pill tone="neutral">{summary.scanned.toLocaleString()} scanned</Pill>
        <Pill tone={summary.with_issues > 0 ? "warn" : "good"}>{summary.with_issues.toLocaleString()} with issues</Pill>
        {summary.item_capped ? <Pill tone="neutral">showing first {summary.wire_item_cap}</Pill> : null}
        {summary.generated_at ? <span className="tabular-nums">Last run {summary.generated_at}</span> : null}
      </div>

      {withIssues.length === 0 ? (
        <EmptyState icon={PlayCircle} title="No issues found" body="Every scanned page passed the on-page checks." />
      ) : (
        <ul className="space-y-2">
          {withIssues.map((item) => (
            <AuditItemRow key={item.id} site={site} item={item} onFixed={onReaudit} />
          ))}
        </ul>
      )}
    </div>
  );
}

function AuditItemRow({ site, item, onFixed }: { site: string; item: SeoAuditItem; onFixed: () => void }) {
  const [open, setOpen] = useState(false);
  const ent = useSiteEntitlements(site);
  const canFix = ent.has("seo_suite") && !ent.isSwitchedOff("seo_suite");

  return (
    <li className="rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden />}
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{item.title || `Post #${item.id}`}</span>
        <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium tabular-nums text-amber-600 dark:text-amber-400">
          {item.issues.length} issue{item.issues.length === 1 ? "" : "s"}
        </span>
      </button>

      {open ? (
        <div className="space-y-3 border-t border-zinc-200 px-3 py-3 dark:border-zinc-800">
          <ul className="flex flex-wrap gap-1.5">
            {item.issues.map((code) => (
              <li key={code}>
                <Pill tone="warn">{auditIssueLabel(code)}</Pill>
              </li>
            ))}
          </ul>
          {canFix ? (
            <QuickFixForm site={site} item={item} onFixed={onFixed} />
          ) : (
            <p className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              One-click fixes (write a meta description, tune the title, set a focus keyphrase, toggle noindex) are included in the Ultimate
              SEO Suite. Upgrade the plan to fix issues from here.
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}

/** Which quick-fix fields to surface for an item, given its issue codes. */
const ALL_FIX_FIELDS: readonly SeoFixField[] = ["title", "desc", "focuskw", "noindex"];

function QuickFixForm({ site, item, onFixed }: { site: string; item: SeoAuditItem; onFixed: () => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {ALL_FIX_FIELDS.map((field) => (
        <FixControl key={field} site={site} postId={item.id} field={field} defaultTitle={item.title} onFixed={onFixed} />
      ))}
    </div>
  );
}

const FIX_META: Readonly<Record<SeoFixField, { label: string; placeholder: string; multiline: boolean; toggle: boolean }>> = {
  title: { label: "SEO title", placeholder: "A concise, keyword-led title", multiline: false, toggle: false },
  desc: { label: "Meta description", placeholder: "A ~155-character summary for search results", multiline: true, toggle: false },
  focuskw: { label: "Focus keyphrase", placeholder: "The main phrase this page targets", multiline: false, toggle: false },
  noindex: { label: "Hide from search (noindex)", placeholder: "", multiline: false, toggle: true },
};

function FixControl({
  site,
  postId,
  field,
  defaultTitle,
  onFixed,
}: {
  site: string;
  postId: number;
  field: SeoFixField;
  defaultTitle: string;
  onFixed: () => void;
}) {
  const meta = FIX_META[field];
  const [value, setValue] = useState(field === "title" ? defaultTitle : "");
  const [noindex, setNoindex] = useState(false);
  const [pending, setPending] = useState(false);
  const [stored, setStored] = useState<string | null>(null);

  const apply = useCallback(async () => {
    setPending(true);
    try {
      const send = meta.toggle ? (noindex ? "1" : "0") : value.trim();
      const result = await applySeoFix(site, { post_id: postId, field, value: send });
      if (isSeoLocked(result)) {
        toast.error("This fix needs the Ultimate SEO Suite.");
        return;
      }
      if (result.ok && "applied" in result) {
        setStored(result.stored);
        toast.success(`${meta.label} saved`);
        onFixed();
      } else {
        toast.error("Fix rejected — check the value and try again.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Fix failed");
    } finally {
      setPending(false);
    }
  }, [site, postId, field, value, noindex, meta, onFixed]);

  return (
    <div className={cn("space-y-1.5", field === "desc" ? "sm:col-span-2" : "")}>
      <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{meta.label}</label>
      <div className="flex items-start gap-2">
        {meta.toggle ? (
          <label className="flex flex-1 items-center gap-2 text-sm text-zinc-700 dark:text-zinc-200">
            <input type="checkbox" checked={noindex} onChange={(e) => setNoindex(e.target.checked)} className="h-4 w-4" />
            Keep this page out of search results
          </label>
        ) : meta.multiline ? (
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={meta.placeholder}
            rows={2}
            maxLength={400}
            className={cn(INPUT, "flex-1 resize-y")}
          />
        ) : (
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={meta.placeholder} maxLength={400} className={cn(INPUT, "flex-1")} />
        )}
        <button type="button" className={cn(BTN_SM)} onClick={apply} disabled={pending || (!meta.toggle && value.trim() === "")}>
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : "Apply"}
        </button>
      </div>
      {stored !== null ? <p className="text-[11px] text-emerald-600 dark:text-emerald-400">Saved: {stored || "(cleared)"}</p> : null}
    </div>
  );
}

// ── the alt-text backfill door (C2) ─────────────────────────────────────────────

interface BackfillState {
  readonly filled: number;
  readonly remaining: number;
  readonly scanned: number;
}

export function SeoAltBackfill({ site, missing }: { site: string; missing: number }) {
  const [preview, setPreview] = useState<{ fillable: number; samples: readonly { id: number; derived: string }[] } | null>(null);
  const [progress, setProgress] = useState<BackfillState | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);

  const runPreview = useCallback(async () => {
    setBusy("preview");
    try {
      const result = await backfillSeoAltReq(site, { dry_run: true });
      if (isSeoLocked(result)) {
        toast.error("Alt-text backfill needs the Ultimate SEO Suite.");
        return;
      }
      setPreview({ fillable: result.fillable, samples: result.samples });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setBusy(null);
    }
  }, [site]);

  const runApply = useCallback(async () => {
    setBusy("apply");
    setProgress(null);
    try {
      let filled = 0;
      let scanned = 0;
      // Loop bounded batches until the connector reports nothing left to fill.
      for (let guard = 0; guard < 50; guard += 1) {
        const result = await backfillSeoAltReq(site, { dry_run: false });
        if (isSeoLocked(result)) {
          toast.error("Alt-text backfill needs the Ultimate SEO Suite.");
          return;
        }
        filled += result.filled;
        scanned += result.scanned;
        setProgress({ filled, scanned, remaining: result.remaining });
        if (result.remaining <= 0 || result.filled <= 0) break;
      }
      setPreview(null);
      toast.success(`Filled alt text on ${filled} image${filled === 1 ? "" : "s"}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Backfill failed");
    } finally {
      setBusy(null);
    }
  }, [site]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-200">
          <ImageOff className="h-4 w-4 text-amber-500" aria-hidden />
          {missing > 0 ? `${missing.toLocaleString()} image${missing === 1 ? "" : "s"} missing alt text` : "All images have alt text"}
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className={cn(BTN_SM)} onClick={runPreview} disabled={busy !== null || missing <= 0}>
            {busy === "preview" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : "Preview"}
          </button>
          <button type="button" className={cn(BTN_PRIMARY)} onClick={runApply} disabled={busy !== null || missing <= 0}>
            {busy === "apply" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Wand2 className="h-4 w-4" aria-hidden />}
            Fill missing alt text
          </button>
        </div>
      </div>

      {preview ? (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-950/40">
          <p className="font-medium text-zinc-700 dark:text-zinc-200">
            {preview.fillable} image{preview.fillable === 1 ? "" : "s"} would get alt text (author-written alt is never overwritten).
          </p>
          {preview.samples.length > 0 ? (
            <ul className="mt-1 space-y-0.5 text-zinc-500 dark:text-zinc-400">
              {preview.samples.slice(0, 5).map((s) => (
                <li key={s.id} className="truncate">
                  #{s.id}: “{s.derived}”
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {progress ? (
        <p className="text-xs tabular-nums text-emerald-600 dark:text-emerald-400">
          Filled {progress.filled} · scanned {progress.scanned} · {progress.remaining} remaining
        </p>
      ) : null}
    </div>
  );
}
