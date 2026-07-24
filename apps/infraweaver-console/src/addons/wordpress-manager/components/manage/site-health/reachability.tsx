"use client";

/**
 * Reachability sub-sections: the broken-link scan (run + read, one-click and bulk
 * "Redirect this") and the 404 feed with redirect suggestions (accept = prefilled
 * create). The scan bounds, SSRF guard and suggestion engine all live in the
 * connector; this only renders the snapshot the `health` panel already carries and
 * fans redirect creation through the signed method.
 */

import { useMemo, useState, type JSX } from "react";
import { Link2Off, Search, RotateCcw, ImageOff, Compass } from "lucide-react";
import { toast } from "@/lib/notify";
import { SectionCard } from "../../demo/widgets";
import { EmptyState, Pill } from "../../demo/manage/kit";
import { BTN, BTN_PRIMARY, INPUT } from "../../demo/manage/manage-ui";
import { DataTable, type Column } from "../../demo/manage/kit/data-table";
import { SelectableDataTable, BulkActionBar, type BulkActionMeta } from "../kit";
import { clearSelection, type IdSelection } from "../../../lib/manage/selection";
import type { SiteHealthActions } from "../../../lib/manage/use-site-health";
import type {
  BrokenLink,
  LinksView,
  NotFoundView,
  RedirectSuggestion,
} from "../../../lib/manage/site-health";
import { deriveRedirectSource, redirectReasonLabel, LockedCard } from "./redirect-form";

const BULK_ACTIONS: readonly BulkActionMeta[] = [
  { id: "redirect", label: "Create redirect →", icon: RotateCcw, confirm: true, confirmTitle: (n) => `Redirect ${n} broken link${n === 1 ? "" : "s"}?`, description: "Each selected internal link becomes a redirect to the bulk target above." },
];

/** Relative "x ago" for a unix-seconds timestamp; empty when absent. Pure. */
function ago(seconds: number | undefined): string {
  if (!seconds) return "—";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export interface ReachabilityProps {
  readonly links: LinksView;
  readonly notfound: NotFoundView;
  readonly suggestions: readonly RedirectSuggestion[];
  readonly actions: SiteHealthActions;
  readonly onRequestRedirect: (source: string, target?: string) => void;
}

export function Reachability({ links, notfound, suggestions, actions, onRequestRedirect }: ReachabilityProps): JSX.Element {
  return (
    <>
      <BrokenLinksCard links={links} actions={actions} onRequestRedirect={onRequestRedirect} />
      <NotFoundCard notfound={notfound} suggestions={suggestions} onRequestRedirect={onRequestRedirect} />
    </>
  );
}

function brokenLinkId(b: BrokenLink): string {
  return `${b.post_id}:${b.url}`;
}

function BrokenLinksCard({
  links,
  actions,
  onRequestRedirect,
}: {
  links: LinksView;
  actions: SiteHealthActions;
  onRequestRedirect: (source: string, target?: string) => void;
}): JSX.Element {
  const [selection, setSelection] = useState<IdSelection>(() => clearSelection());
  const [bulkTarget, setBulkTarget] = useState("");
  const [scanning, setScanning] = useState(false);

  const summary = links.last_scan_summary;
  const broken = useMemo<readonly BrokenLink[]>(() => (summary?.broken ?? []) as readonly BrokenLink[], [summary]);
  const brokenImages = summary?.broken_images ?? [];

  async function scan(): Promise<void> {
    setScanning(true);
    try {
      await actions.scan();
      toast.success("Scan complete.");
    } catch {
      /* the hook toasts the error */
    } finally {
      setScanning(false);
    }
  }

  async function runBulk(_actionId: string, id: string): Promise<{ ok: boolean; message?: string }> {
    if (bulkTarget.trim() === "") return { ok: false, message: "Enter a bulk redirect target above first." };
    const source = deriveRedirectSource(id.slice(id.indexOf(":") + 1));
    if (!source) return { ok: false, message: "External link — can't derive a rooted source." };
    try {
      const res = await actions.createRedirect({ source, target: bulkTarget.trim(), type: 301, match: "exact" });
      return res.ok ? { ok: true } : { ok: false, message: redirectReasonLabel(res.reason) };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Failed" };
    }
  }

  const columns: readonly Column<BrokenLink>[] = [
    { key: "post", header: "In post", primary: true, render: (b) => <span className="text-xs">{b.post_title || `#${b.post_id}`}</span> },
    { key: "url", header: "Broken URL", render: (b) => <span className="font-mono text-[11px] break-all">{b.url}</span> },
    { key: "status", header: "Status", align: "right", render: (b) => <Pill tone="critical">{String(b.status)}</Pill> },
    {
      key: "fix",
      header: "",
      render: (b) => {
        const source = deriveRedirectSource(b.url);
        return source ? (
          <button type="button" className={BTN} onClick={() => onRequestRedirect(source)}>
            <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Redirect this
          </button>
        ) : (
          <span className="text-xs text-zinc-400">external</span>
        );
      },
    },
  ];

  const meta = summary
    ? `Scanned ${summary.scanned_posts ?? 0} posts · checked ${summary.checked_links ?? 0} links · ${summary.partial ? "partial (budget hit)" : "complete"} · ${ago(summary.generated_at)}`
    : "No scan yet.";

  return (
    <SectionCard
      title="Broken links"
      description="Dead links in your published content — scan, then fix a dead end with a one-click redirect."
      icon={Link2Off}
      action={
        <button type="button" className={BTN_PRIMARY} onClick={() => void scan()} disabled={scanning || actions.pending}>
          <Search className="h-3.5 w-3.5" aria-hidden /> {scanning ? "Scanning…" : "Scan now"}
        </button>
      }
    >
      <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">{meta}</p>

      {broken.length > 0 ? (
        <div className="mb-3">
          <label htmlFor="sh-bulk-target" className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
            Bulk redirect target (for selected internal links)
          </label>
          <input
            id="sh-bulk-target"
            className={`${INPUT} mt-1`}
            value={bulkTarget}
            onChange={(e) => setBulkTarget(e.target.value)}
            placeholder="/ or /new-home"
          />
        </div>
      ) : null}

      <SelectableDataTable
        columns={columns}
        rows={broken}
        caption="Broken links"
        getRowId={brokenLinkId}
        rowLabel={(b) => `Select broken link ${b.url}`}
        selection={selection}
        onSelectionChange={setSelection}
        empty={<EmptyState icon={Link2Off} title="No broken links" body="The last scan found no dead links in your content." />}
      />

      <BulkActionBar
        count={selection.size}
        ids={[...selection]}
        actions={BULK_ACTIONS}
        runItem={runBulk}
        onClear={() => setSelection(clearSelection())}
        onComplete={() => setSelection(clearSelection())}
      />

      {brokenImages.length > 0 ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
          <ImageOff className="h-3.5 w-3.5" aria-hidden />
          {brokenImages.length} broken image{brokenImages.length === 1 ? "" : "s"} — see the Media explorer's broken filter.
        </p>
      ) : null}
    </SectionCard>
  );
}

interface NotFoundOrSuggestion {
  readonly id: string;
  readonly path: string;
  readonly count: number | null;
  readonly last_seen: number | null;
  readonly source: string;
  readonly suggestedTarget: string | null;
  readonly confidence: string | null;
}

function NotFoundCard({
  notfound,
  suggestions,
  onRequestRedirect,
}: {
  notfound: NotFoundView;
  suggestions: readonly RedirectSuggestion[];
  onRequestRedirect: (source: string, target?: string) => void;
}): JSX.Element {
  if (notfound.locked) {
    return (
      <SectionCard title="404s & suggestions" description="Recent not-found paths ranked, with suggested redirect targets." icon={Compass}>
        <LockedCard title="404 recovery — included in Pro" body="Upgrade to see your top 404s and accept one-click redirect suggestions." />
      </SectionCard>
    );
  }

  const byPath = new Map<string, RedirectSuggestion>();
  for (const s of suggestions) byPath.set(s.path, s);

  const rows: readonly NotFoundOrSuggestion[] = notfound.top.map((n) => {
    const s = byPath.get(n.path);
    return {
      id: n.path,
      path: n.path,
      count: n.count,
      last_seen: n.last_seen,
      source: n.source,
      suggestedTarget: s?.target ?? null,
      confidence: s?.confidence ?? null,
    };
  });

  const columns: readonly Column<NotFoundOrSuggestion>[] = [
    { key: "path", header: "Path", primary: true, render: (r) => <span className="font-mono text-[11px] break-all">{r.path}</span> },
    { key: "count", header: "Hits", align: "right", render: (r) => <span className="tabular-nums">{r.count ?? "—"}</span> },
    { key: "seen", header: "Last seen", render: (r) => <span className="text-xs">{r.last_seen ? ago(r.last_seen) : "—"}</span> },
    {
      key: "suggestion",
      header: "Suggested target",
      render: (r) =>
        r.suggestedTarget ? (
          <span className="flex items-center gap-2 font-mono text-[11px]">
            {r.suggestedTarget}
            {r.confidence ? <Pill tone="good">{r.confidence}</Pill> : null}
          </span>
        ) : (
          <span className="text-xs text-zinc-400">—</span>
        ),
    },
    {
      key: "accept",
      header: "",
      render: (r) => (
        <button type="button" className={BTN} onClick={() => onRequestRedirect(r.path, r.suggestedTarget ?? undefined)}>
          <RotateCcw className="h-3.5 w-3.5" aria-hidden /> {r.suggestedTarget ? "Accept" : "Redirect"}
        </button>
      ),
    },
  ];

  return (
    <SectionCard
      title="404s & suggestions"
      description="Recent not-found paths ranked by hits, with likely redirect targets from your published content."
      icon={Compass}
    >
      <DataTable
        columns={columns}
        rows={rows}
        caption="Recent 404s"
        getRowKey={(r) => r.id}
        empty={<EmptyState icon={Compass} title="No 404s recorded" body="Turn on 404 logging in Redirects to start collecting missing paths." />}
      />
    </SectionCard>
  );
}
