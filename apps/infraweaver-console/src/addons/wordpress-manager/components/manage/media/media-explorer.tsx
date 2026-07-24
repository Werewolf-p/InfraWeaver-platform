"use client";

/**
 * The fused Media Explorer — the flagship. ONE surface where every asset shows its
 * folder, its lossless/optimization state and its CDN/offload state on the same
 * row; where the filters ("Not lossless", "Not on CDN") and the bulk verbs ("Make
 * lossless", "Offload to CDN", "Restore") operate across the whole matching set,
 * not just the visible page. Optimization + CDN offload are FUSED INTO the folders
 * explorer here — not a separate tab.
 *
 * It composes the shared foundation kit (SelectableDataTable, BulkActionBar,
 * RunLedger, TierGate) and the Manage conventions (PanelError/Spinner, FilterTabs,
 * Pill, EmptyState) over the signed `media.*` read + act methods. CDN host-rewrite
 * is a site BANNER (no per-asset record), never a column.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Cloud, HardDrive, Images } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import { EmptyState } from "../../demo/manage/kit/empty-state";
import { FilterTabs } from "../../demo/manage/kit/filter-tabs";
import { Pill } from "../../demo/manage/kit/pill";
import { PanelError, Spinner } from "../../demo/manage/panel-shell";
import { MediaPanel } from "../../demo/manage/panels-media";
import { SelectableDataTable } from "../kit/select-table";
import { BulkActionBar } from "../kit/bulk-bar";
import { TierGate } from "../kit/tier-gate";
import { useSiteEntitlements } from "../../../lib/manage/use-site-entitlements";
import {
  OPTIMIZE_BATCH,
  PER_PAGE_DEFAULT,
  type MediaListParams,
  type MimeGroup,
  type OffloadFilter,
  type OptimizationFilter,
} from "../../../lib/manage/media";
import {
  mediaKeys,
  postMediaWrite,
  selectAllMatchingIds,
  useMediaList,
  useMediaStatus,
  useMediaTree,
} from "../../../lib/manage/use-media";
import { buildAssetColumns } from "./media-asset-columns";
import { MediaViewer } from "./viewer/media-viewer";
import { MediaFolderTree } from "./media-folder-tree";
import { MediaFilterBar, type AttentionFilter } from "./media-filter-bar";
import {
  MEDIA_BULK_ACTIONS,
  MEDIA_BULK_VERB,
  batchAssetIds,
  batchKey,
  batchLabel,
  outcomeFromWrite,
  type MediaBulkActionId,
} from "./media-bulk";

/** The combined attention filter → the two server-side predicates. */
function predicatesFor(attention: AttentionFilter): { optimization: OptimizationFilter; offload: OffloadFilter } {
  if (attention === "not-lossless") return { optimization: "unoptimized", offload: "all" };
  if (attention === "not-on-cdn") return { optimization: "all", offload: "local" };
  return { optimization: "all", offload: "all" };
}

interface ExplorerFilters {
  readonly folderId: number;
  readonly attention: AttentionFilter;
  readonly mime: MimeGroup;
  readonly search: string;
  readonly page: number;
}

const INITIAL_FILTERS: ExplorerFilters = { folderId: -1, attention: "all", mime: "all", search: "", page: 1 };

/** The site-wide CDN host-rewrite banner (per-asset offload is the "CDN" column). */
function CdnBanner({ active }: { active: boolean }): ReactNode {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-900/40">
      <Cloud className="mt-0.5 h-4 w-4 shrink-0 text-sky-500" aria-hidden />
      <p className="text-zinc-600 dark:text-zinc-300">
        {active
          ? "CDN host-rewrite is active site-wide — same-origin asset URLs are served from your pull CDN. Per-asset bucket offload shows in the CDN column."
          : "CDN host-rewrite is off. The CDN column shows which assets are offloaded to your storage bucket."}
      </p>
    </div>
  );
}

export function MediaExplorer({ site }: { site: string }): ReactNode {
  const queryClient = useQueryClient();
  const ent = useSiteEntitlements(site);
  const [tab, setTab] = useState<"explorer" | "storage">("explorer");
  const [filters, setFilters] = useState<ExplorerFilters>(INITIAL_FILTERS);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  // The click-to-open viewer: which asset is open (null = closed). Deep-linkable via
  // `?asset=<id>`, so a viewer URL is shareable and survives a reload.
  const [viewerId, setViewerId] = useState<number | null>(null);

  const predicates = predicatesFor(filters.attention);
  const listParams: MediaListParams = useMemo(
    () => ({
      page: filters.page,
      per_page: PER_PAGE_DEFAULT,
      folder_id: filters.folderId,
      mime_group: filters.mime,
      optimization: predicates.optimization,
      offload: predicates.offload,
      ...(filters.search ? { search: filters.search } : {}),
    }),
    [filters, predicates.optimization, predicates.offload],
  );

  const list = useMediaList(site, listParams);
  const tree = useMediaTree(site);
  const status = useMediaStatus(site);

  // A filter change invalidates the prior selection (its ids may no longer match).
  const patchFilters = useCallback((patch: Partial<ExplorerFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch, page: patch.page ?? 1 }));
    if (!("page" in patch)) setSelection(new Set());
  }, []);

  const invalidateMedia = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["wordpress-media-list", site] });
    void queryClient.invalidateQueries({ queryKey: mediaKeys.status(site) });
    void queryClient.invalidateQueries({ queryKey: mediaKeys.tree(site) });
  }, [queryClient, site]);

  // ── viewer open/close, kept in sync with `?asset=<id>` (deep-linkable) ─────────
  const syncAssetParam = useCallback((id: number | null) => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("asset", String(id));
    else url.searchParams.delete("asset");
    window.history.replaceState(null, "", url.toString());
  }, []);
  const openViewer = useCallback((id: number) => { setViewerId(id); syncAssetParam(id); }, [syncAssetParam]);
  const closeViewer = useCallback(() => { setViewerId(null); syncAssetParam(null); }, [syncAssetParam]);
  const navigateViewer = useCallback((id: number) => { setViewerId(id); syncAssetParam(id); }, [syncAssetParam]);

  // Deep link: honour `?asset=<id>` on first mount (a shared viewer URL).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = new URL(window.location.href).searchParams.get("asset");
    const id = raw ? Number(raw) : NaN;
    if (Number.isInteger(id) && id > 0) setViewerId(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The ordered id set beneath the viewer — the live filtered page — for prev/next.
  const orderedIds = useMemo(() => (list.data?.items ?? []).map((asset) => asset.id), [list.data]);

  // ── select-all-matching (the honest "select the query, not the page") ─────────
  const onSelectAllMatching = useCallback(async () => {
    setSelecting(true);
    try {
      const base: MediaListParams = {
        folder_id: filters.folderId,
        mime_group: filters.mime,
        optimization: predicates.optimization,
        offload: predicates.offload,
        ...(filters.search ? { search: filters.search } : {}),
      };
      const result = await selectAllMatchingIds(site, base);
      setSelection(new Set(result.ids.map(String)));
      if (result.capped) toast.warning(`Selected ${result.ids.length} — more matched than we could select at once; refine the filter for the rest.`);
      else toast.success(`Selected ${result.ids.length} matching asset(s)`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not select the matching set");
    } finally {
      setSelecting(false);
    }
  }, [site, filters.folderId, filters.mime, filters.search, predicates.optimization, predicates.offload]);

  // ── folder mutations (terms only, signed media.folder) ────────────────────────
  const folderMutations = ent.has("media_folders") && !ent.isSwitchedOff("media_folders");
  const createFolder = useCallback(
    async (name: string, parent: number) => {
      await postMediaWrite(site, "folder", { op: "create", name, ...(parent ? { parent } : {}) });
      toast.success(`Folder “${name}” created`);
      invalidateMedia();
    },
    [site, invalidateMedia],
  );
  const deleteFolder = useCallback(
    async (id: number) => {
      await postMediaWrite(site, "folder", { op: "delete", id });
      if (filters.folderId === id) patchFilters({ folderId: -1 });
      toast.success("Folder deleted (files were left untouched)");
      invalidateMedia();
    },
    [site, invalidateMedia, filters.folderId, patchFilters],
  );

  // ── bulk run wiring: chunk the selection into ≤ OPTIMIZE_BATCH signed calls ────
  const selectedIds = useMemo(() => [...selection].map(Number).filter((n) => n > 0), [selection]);
  const batches = useMemo(() => batchAssetIds(selectedIds), [selectedIds]);
  const bulkIds = useMemo(() => batches.map((_, i) => batchKey(i)), [batches]);

  const runBatch = useCallback(
    async (actionId: string, key: string) => {
      const idx = Number(key.slice(1));
      const ids = batches[idx] ?? [];
      const verb = MEDIA_BULK_VERB[actionId as MediaBulkActionId];
      const params = verb === "offload" ? { op: "offload" as const, ids } : { ids };
      const result = await postMediaWrite(site, verb, params);
      return outcomeFromWrite(verb, result);
    },
    [site, batches],
  );

  const batchItemLabel = useCallback(
    (key: string) => {
      const idx = Number(key.slice(1));
      return batchLabel(batches[idx]?.length ?? 0, idx * OPTIMIZE_BATCH);
    },
    [batches],
  );

  const clearSelection = useCallback(() => setSelection(new Set()), []);

  const data = list.data;
  const features = data?.features ?? { media_folders: false, image_optimization: false, cdn_rewrite: false };
  const columns = useMemo(() => buildAssetColumns(features, openViewer), [features, openViewer]);
  const bulkActions = features.image_optimization ? MEDIA_BULK_ACTIONS : [];

  useEffect(() => {
    // Drop selected ids that are no longer on the page AND not part of a matching set
    // is handled by patchFilters; nothing to do here beyond keeping the effect honest.
  }, [data]);

  // ── render ────────────────────────────────────────────────────────────────────
  if (tab === "storage") {
    return (
      <div className="space-y-4">
        <ExplorerTabs tab={tab} onChange={setTab} />
        <MediaPanel site={site} />
      </div>
    );
  }

  if (list.error) {
    return (
      <div className="space-y-4">
        <ExplorerTabs tab={tab} onChange={setTab} />
        <PanelError message={list.error.message} onRetry={() => void list.refetch()} />
      </div>
    );
  }

  if (data && data.locked) {
    return (
      <div className="space-y-4">
        <ExplorerTabs tab={tab} onChange={setTab} />
        <TierGate site={site} flag="image_optimization">
          <span />
        </TierGate>
      </div>
    );
  }

  const loading = list.isPending && !data;
  const totalPages = data?.pages ?? 1;

  return (
    <div className="space-y-4">
      <ExplorerTabs tab={tab} onChange={setTab} />
      <CdnBanner active={features.cdn_rewrite && status.data?.cdn_rewrite?.unlocked === true} />

      {!features.image_optimization && features.media_folders ? (
        <div className="rounded-lg border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
          Image optimization & CDN offload are included in Pro — upgrade to make images lossless and offload them from this same view.
        </div>
      ) : null}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <aside className="lg:sticky lg:top-4 lg:w-56 lg:shrink-0">
          <MediaFolderTree
            tree={tree.data?.tree ?? null}
            activeFolderId={filters.folderId}
            onSelect={(folderId) => patchFilters({ folderId })}
            onCreate={folderMutations ? createFolder : undefined}
            onDelete={folderMutations ? deleteFolder : undefined}
          />
        </aside>

        <div className="min-w-0 flex-1 space-y-3">
          <MediaFilterBar
            attention={filters.attention}
            onAttentionChange={(attention) => patchFilters({ attention })}
            mime={filters.mime}
            onMimeChange={(mime) => patchFilters({ mime })}
            search={filters.search}
            onSearchChange={(search) => patchFilters({ search })}
            optimizationEnabled={features.image_optimization}
            counts={{ notLossless: status.data?.non_lossless, notOnCdn: status.data?.not_offloaded }}
            matchingCount={data?.total ?? 0}
            onSelectAllMatching={onSelectAllMatching}
            selecting={selecting}
          />

          {loading ? (
            <div className="flex items-center justify-center rounded-xl border border-zinc-200 py-12 dark:border-zinc-800">
              <Spinner className="h-5 w-5 animate-spin text-sky-500" />
            </div>
          ) : (
            <>
              <SelectableDataTable
                columns={columns}
                rows={data?.items ?? []}
                caption="Media assets with folder, CDN and lossless state"
                getRowId={(asset) => String(asset.id)}
                selection={selection}
                onSelectionChange={setSelection}
                rowLabel={(asset) => `Select ${asset.filename || asset.id}`}
                empty={<EmptyState icon={Images} title="No assets match" body="Try a different folder, type, or clear the filter." />}
                footer={
                  data ? (
                    <span className="tabular-nums">
                      {data.total.toLocaleString()} asset(s) · page {data.page} of {Math.max(1, totalPages)}
                    </span>
                  ) : null
                }
              />

              <Pager
                page={filters.page}
                pages={totalPages}
                onPage={(page) => patchFilters({ page })}
              />
            </>
          )}

          <BulkActionBar
            count={selectedIds.length}
            ids={bulkIds}
            actions={bulkActions}
            runItem={runBatch}
            onClear={clearSelection}
            onComplete={invalidateMedia}
            itemLabel={batchItemLabel}
          />
        </div>
      </div>

      {viewerId !== null ? (
        <MediaViewer
          site={site}
          assetId={viewerId}
          orderedIds={orderedIds}
          onClose={closeViewer}
          onNavigate={navigateViewer}
          onChanged={invalidateMedia}
        />
      ) : null}
    </div>
  );
}

/** Sub-tab switch between the fused Explorer and the classic Storage report. */
function ExplorerTabs({ tab, onChange }: { tab: "explorer" | "storage"; onChange: (t: "explorer" | "storage") => void }): ReactNode {
  return (
    <FilterTabs
      options={[
        { value: "explorer", label: "Explorer" },
        { value: "storage", label: "Storage" },
      ]}
      value={tab}
      onChange={(v) => onChange(v as "explorer" | "storage")}
      ariaLabel="Media view"
    />
  );
}

/** Prev/next pager; hidden when a single page. */
function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (page: number) => void }): ReactNode {
  if (pages <= 1) return null;
  const btn =
    "inline-flex items-center gap-1 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:border-zinc-400 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200";
  return (
    <div className="flex items-center justify-between">
      <button type="button" className={cn(btn)} disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <span className="flex items-center gap-1.5 text-sm text-zinc-500 dark:text-zinc-400">
        <HardDrive className="h-4 w-4" aria-hidden /> Page {page} of {pages}
      </span>
      <button type="button" className={cn(btn)} disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </div>
  );
}
