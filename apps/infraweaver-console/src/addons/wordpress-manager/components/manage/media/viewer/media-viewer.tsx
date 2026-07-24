"use client";

/**
 * MediaViewer — the click-to-open image viewer (Agent A). It reproduces WordPress's
 * "Attachment details / Edit Image" panel and FUSES our features onto it: the native
 * read-only Details + editable Alt/Title/Caption/Description + File URL/copy panels,
 * plus per-asset optimization + CDN state with one-click actions, the protection
 * toggle, folder + tags, where-used, and Edit Image (crop/rotate/flip/scale). It is a
 * faithful React port that consumes the SINGLE panel registry (`panel-registry.ts`,
 * the mirror of the connector's canonical `iwsl-media-viewer.js`) and the injected
 * console adapter. Presentation concerns (overlay, zoom/pan, prev/next, keyboard,
 * focus trap) stay in this shell; the panels are data-driven from the registry.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { useMediaAsset } from "../../../../lib/manage/use-media";
import type { MediaAssetDetail, MediaEditParams } from "../../../../lib/manage/media";
import { createConsoleAdapter, type MetaFields } from "./viewer-adapter";
import {
  VIEWER_PANELS,
  formatBytes,
  isPanelUnlocked,
  nextZoom,
  ZOOM_MIN,
  type PanelSpec,
  type ViewerFeatures,
} from "./panel-registry";

interface MediaViewerProps {
  readonly site: string;
  readonly assetId: number;
  /** The ordered id set beneath the viewer (the live filtered page) for prev/next. */
  readonly orderedIds: readonly number[];
  readonly onClose: () => void;
  readonly onNavigate: (id: number) => void;
  /** Fires after any mutation so the list/tree/counters can refresh. */
  readonly onChanged?: () => void;
}

export function MediaViewer({ site, assetId, orderedIds, onClose, onNavigate, onChanged }: MediaViewerProps): ReactNode {
  const adapter = useMemo(() => createConsoleAdapter(site), [site]);
  const query = useMediaAsset(site, assetId);
  const reply = query.data;
  const asset = reply && reply.asset ? (reply.asset as MediaAssetDetail) : null;
  const features: ViewerFeatures = reply?.features ?? { media_folders: false, image_optimization: false };

  const index = orderedIds.indexOf(assetId);
  const hasPrev = index > 0;
  const hasNext = index >= 0 && index < orderedIds.length - 1;
  const goPrev = useCallback(() => { if (hasPrev) onNavigate(orderedIds[index - 1]); }, [hasPrev, index, orderedIds, onNavigate]);
  const goNext = useCallback(() => { if (hasNext) onNavigate(orderedIds[index + 1]); }, [hasNext, index, orderedIds, onNavigate]);

  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const refresh = useCallback(() => {
    void query.refetch();
    onChanged?.();
  }, [query, onChanged]);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Media viewer"
      tabIndex={-1}
      className="fixed inset-0 z-[100000] flex bg-zinc-950/90 outline-none"
      onKeyDown={(ev) => {
        if (ev.key === "Escape") onClose();
        else if (ev.key === "ArrowLeft") goPrev();
        else if (ev.key === "ArrowRight") goNext();
      }}
      onClick={(ev) => { if (ev.target === ev.currentTarget) onClose(); }}
    >
      <ImageStage
        asset={asset}
        position={index >= 0 && orderedIds.length > 1 ? `${index + 1} of ${orderedIds.length}` : ""}
        hasPrev={hasPrev}
        hasNext={hasNext}
        onPrev={goPrev}
        onNext={goNext}
      />
      <aside className="flex w-[380px] shrink-0 flex-col overflow-y-auto border-l border-zinc-800 bg-white p-5 dark:bg-zinc-950" aria-label="Attachment details">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{asset?.title || asset?.filename || "Attachment"}</h2>
          <button type="button" onClick={onClose} aria-label="Close viewer" className="rounded p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">✕</button>
        </div>
        {query.isPending ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : query.error ? (
          <p className="text-sm text-red-600">{query.error.message}</p>
        ) : reply?.locked ? (
          <LockedNotice reasons={(reply.gate?.reason ? [reply.gate.reason] : []) as string[]} />
        ) : reply?.found === false || !asset ? (
          <p className="text-sm text-zinc-500">This attachment no longer exists.</p>
        ) : (
          <Panels adapter={adapter} asset={asset} features={features} onChanged={refresh} onClose={onClose} onNavigate={goNext} />
        )}
      </aside>
    </div>
  );
}

function LockedNotice({ reasons }: { reasons: string[] }): ReactNode {
  return (
    <div className="rounded-md border border-amber-400/40 bg-amber-400/5 p-3 text-sm text-amber-700 dark:text-amber-300">
      <p className="font-medium">This feature is locked for this site.</p>
      {reasons.length ? <ul className="ml-4 mt-1 list-disc">{reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
    </div>
  );
}

// ── image stage: zoom / pan / prev-next ─────────────────────────────────────────
function ImageStage({
  asset,
  position,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: {
  asset: MediaAssetDetail | null;
  position: string;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}): ReactNode {
  const [zoom, setZoom] = useState(ZOOM_MIN);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => { setZoom(ZOOM_MIN); setPan({ x: 0, y: 0 }); }, [asset?.id]);

  const zoomTo = useCallback((intent: "zoomIn" | "zoomOut" | "zoomReset" | "toggle") => {
    setZoom((z) => {
      const nz = nextZoom(z, intent);
      if (nz === ZOOM_MIN) setPan({ x: 0, y: 0 });
      return nz;
    });
  }, []);

  const isImage = asset && asset.mime.startsWith("image/");
  const btn = "absolute top-1/2 -translate-y-1/2 rounded bg-black/40 px-3 py-4 text-2xl text-white disabled:opacity-25";
  return (
    <div
      className="relative flex flex-1 items-center justify-center overflow-hidden"
      onWheel={(ev) => { ev.preventDefault(); zoomTo(ev.deltaY < 0 ? "zoomIn" : "zoomOut"); }}
    >
      {position ? <span className="absolute left-4 top-4 rounded-full bg-black/40 px-3 py-1 text-xs text-zinc-100">{position}</span> : null}
      {isImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={asset.url}
          alt={asset.alt || ""}
          draggable={false}
          onDoubleClick={() => zoomTo("toggle")}
          onMouseDown={(ev) => { if (zoom > ZOOM_MIN) { drag.current = { x: ev.clientX - pan.x, y: ev.clientY - pan.y }; } }}
          onMouseMove={(ev) => { if (drag.current) setPan({ x: ev.clientX - drag.current.x, y: ev.clientY - drag.current.y }); }}
          onMouseUp={() => { drag.current = null; }}
          onMouseLeave={() => { drag.current = null; }}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, cursor: zoom > ZOOM_MIN ? "grab" : "default" }}
          className="max-h-full max-w-full select-none transition-transform"
        />
      ) : (
        <div className="text-zinc-400">No preview for {asset?.mime || "this file"}</div>
      )}
      <button type="button" aria-label="Previous" className={cn(btn, "left-3")} disabled={!hasPrev} onClick={onPrev}>‹</button>
      <button type="button" aria-label="Next" className={cn(btn, "right-3")} disabled={!hasNext} onClick={onNext}>›</button>
      {isImage ? (
        <div className="absolute bottom-4 right-4 flex gap-1.5">
          <button type="button" aria-label="Zoom out" onClick={() => zoomTo("zoomOut")} className="rounded bg-black/50 px-3 py-1.5 text-white">−</button>
          <button type="button" aria-label="Reset zoom" onClick={() => zoomTo("zoomReset")} className="rounded bg-black/50 px-3 py-1.5 text-white">○</button>
          <button type="button" aria-label="Zoom in" onClick={() => zoomTo("zoomIn")} className="rounded bg-black/50 px-3 py-1.5 text-white">＋</button>
        </div>
      ) : null}
    </div>
  );
}

// ── the panel rail (data-driven from VIEWER_PANELS) ────────────────────────────
function Panels(props: {
  adapter: ReturnType<typeof createConsoleAdapter>;
  asset: MediaAssetDetail;
  features: ViewerFeatures;
  onChanged: () => void;
  onClose: () => void;
  onNavigate: () => void;
}): ReactNode {
  return (
    <div className="space-y-4">
      {VIEWER_PANELS.map((panel) => (
        <PanelBlock key={panel.id} panel={panel} {...props} />
      ))}
    </div>
  );
}

function PanelBlock({
  panel,
  adapter,
  asset,
  features,
  onChanged,
  onClose,
  onNavigate,
}: {
  panel: PanelSpec;
  adapter: ReturnType<typeof createConsoleAdapter>;
  asset: MediaAssetDetail;
  features: ViewerFeatures;
  onChanged: () => void;
  onClose: () => void;
  onNavigate: () => void;
}): ReactNode {
  const unlocked = isPanelUnlocked(panel, features);
  return (
    <section data-panel={panel.id} aria-label={panel.label}>
      {panel.kind !== "detail" || panel.id === "details" ? (
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">{panel.label}</h3>
      ) : null}
      {!unlocked ? (
        <p className="text-xs text-zinc-400">Requires the {panel.gate?.replace("_", " ")} tier.</p>
      ) : (
        <PanelBody panel={panel} adapter={adapter} asset={asset} onChanged={onChanged} onClose={onClose} onNavigate={onNavigate} />
      )}
    </section>
  );
}

function PanelBody({
  panel,
  adapter,
  asset,
  onChanged,
  onClose,
  onNavigate,
}: {
  panel: PanelSpec;
  adapter: ReturnType<typeof createConsoleAdapter>;
  asset: MediaAssetDetail;
  onChanged: () => void;
  onClose: () => void;
  onNavigate: () => void;
}): ReactNode {
  switch (panel.id) {
    case "edit":
      return <EditImage adapter={adapter} asset={asset} onChanged={onChanged} />;
    case "details":
      return <Details asset={asset} />;
    case "alt":
    case "title":
    case "caption":
    case "description":
      return <MetaField panel={panel} adapter={adapter} asset={asset} onChanged={onChanged} />;
    case "fileurl":
      return <FileUrl asset={asset} />;
    case "optimization":
      return <OptimizationPanel adapter={adapter} asset={asset} onChanged={onChanged} />;
    case "offload":
      return <OffloadPanel adapter={adapter} asset={asset} onChanged={onChanged} />;
    case "protect":
      return <ProtectToggle panel={panel} adapter={adapter} asset={asset} onChanged={onChanged} />;
    case "folder":
      return <FolderField adapter={adapter} asset={asset} onChanged={onChanged} />;
    case "tags":
      return <TagsField adapter={adapter} asset={asset} onChanged={onChanged} />;
    case "usage":
      return <UsagePanel asset={asset} adapter={adapter} />;
    case "actions":
      return <Actions adapter={adapter} asset={asset} onClose={onClose} onNavigate={onNavigate} />;
    default:
      return null;
  }
}

function Details({ asset }: { asset: MediaAssetDetail }): ReactNode {
  const rows: [string, string][] = [
    ["Uploaded on", asset.date],
    ["Uploaded by", asset.uploader?.name || "—"],
    ["File name", asset.filename],
    ["File type", asset.mime],
    ["File size", formatBytes(asset.filesize)],
    ["Dimensions", asset.width && asset.height ? `${asset.width} × ${asset.height}` : "—"],
  ];
  return (
    <dl className="grid grid-cols-[7rem_1fr] gap-x-2 gap-y-1 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-zinc-500">{k}</dt>
          <dd className="truncate text-zinc-800 dark:text-zinc-200">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function MetaField({
  panel,
  adapter,
  asset,
  onChanged,
}: {
  panel: PanelSpec;
  adapter: ReturnType<typeof createConsoleAdapter>;
  asset: MediaAssetDetail;
  onChanged: () => void;
}): ReactNode {
  const initial = String((asset as unknown as Record<string, unknown>)[panel.id] ?? "");
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(initial), [initial]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const fields = { [panel.id]: value } as MetaFields;
      const res = await adapter.updateMeta(asset.id, fields, asset.modified);
      if (res.conflict) {
        toast.error("Someone else edited this while you were — reload to see their version, then re-apply.");
      } else if (res.ok) {
        toast.success(`${panel.label} saved`);
        onChanged();
      } else {
        toast.error(res.reason || "Could not save");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }, [adapter, asset.id, asset.modified, panel.id, panel.label, value, onChanged]);

  const cls = "w-full rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900";
  return (
    <div className="space-y-1">
      {panel.multiline ? (
        <textarea rows={2} className={cls} value={value} onChange={(e) => setValue(e.target.value)} aria-label={panel.label} />
      ) : (
        <input type="text" className={cls} value={value} onChange={(e) => setValue(e.target.value)} aria-label={panel.label} />
      )}
      {panel.help ? <p className="text-[11px] text-zinc-500">{panel.help}</p> : null}
      <button type="button" disabled={saving || value === initial} onClick={save} className="rounded bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900">
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

function FileUrl({ asset }: { asset: MediaAssetDetail }): ReactNode {
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    toast.success("Copied to clipboard");
  };
  return (
    <div className="space-y-1">
      <code className="block break-all rounded bg-zinc-100 p-1.5 text-[11px] dark:bg-zinc-900">{asset.url}</code>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => copy(asset.url)} className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700">Copy URL to clipboard</button>
        {asset.offload?.url ? (
          <button type="button" onClick={() => copy(asset.offload!.url!)} className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700">Copy CDN URL</button>
        ) : null}
      </div>
    </div>
  );
}

function OptimizationPanel({ adapter, asset, onChanged }: { adapter: ReturnType<typeof createConsoleAdapter>; asset: MediaAssetDetail; onChanged: () => void }): ReactNode {
  const opt = asset.optimization;
  const [busy, setBusy] = useState(false);
  if (!opt) return null;
  const run = async () => {
    setBusy(true);
    try {
      await adapter.optimize(asset.id);
      toast.success("Optimization queued");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };
  if (opt.status === "optimized") {
    return <p className="text-xs text-emerald-600">Optimized{opt.saved_pct != null ? ` — saved ${opt.saved_pct}%` : ""}{opt.converter ? ` (${opt.converter})` : ""}</p>;
  }
  if (opt.status === "ineligible") return <p className="text-xs text-zinc-500">Not an optimizable image type.</p>;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-amber-600">Not lossless</span>
      <button type="button" disabled={busy} onClick={run} className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-40">Make lossless</button>
    </div>
  );
}

function OffloadPanel({ adapter, asset, onChanged }: { adapter: ReturnType<typeof createConsoleAdapter>; asset: MediaAssetDetail; onChanged: () => void }): ReactNode {
  const off = asset.offload;
  const [busy, setBusy] = useState(false);
  if (!off) return null;
  const act = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(label);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };
  if (off.status === "offloaded") {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-sky-600">On CDN{off.variant ? ` (${off.variant})` : ""}</span>
        <button type="button" disabled={busy} onClick={() => act(() => adapter.restore(asset.id), "Restored locally")} className="rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700">Restore</button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-zinc-500">Local</span>
      <button type="button" disabled={busy} onClick={() => act(() => adapter.offload(asset.id, "offload"), "Offloaded to CDN")} className="rounded bg-sky-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-40">Offload to CDN</button>
    </div>
  );
}

function ProtectToggle({ panel, adapter, asset, onChanged }: { panel: PanelSpec; adapter: ReturnType<typeof createConsoleAdapter>; asset: MediaAssetDetail; onChanged: () => void }): ReactNode {
  const [checked, setChecked] = useState(asset.protected);
  useEffect(() => setChecked(asset.protected), [asset.protected]);
  const toggle = async (next: boolean) => {
    setChecked(next);
    try {
      await adapter.protect([asset.id], next);
      onChanged();
    } catch (e) {
      setChecked(!next);
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };
  return (
    <div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={checked} onChange={(e) => void toggle(e.target.checked)} />
        <span>InfraWeaver protection</span>
      </label>
      {panel.help ? <p className="mt-1 text-[11px] text-zinc-500">{panel.help}</p> : null}
    </div>
  );
}

function FolderField({ adapter, asset, onChanged }: { adapter: ReturnType<typeof createConsoleAdapter>; asset: MediaAssetDetail; onChanged: () => void }): ReactNode {
  // A single-select surface bound to media.folder assign. The tree of options is
  // supplied by the Explorer's tree query in a fuller build; here we expose the
  // current folder and an "Unfile" action (assign to folder 0) — filing to a new
  // folder rides the Explorer's tree drag/select, so this stays minimal + honest.
  const current = asset.folder ? asset.folder.name : "Unfiled";
  const unfile = async () => {
    try {
      await adapter.assignFolder(asset.id, 0);
      toast.success("Moved to Unfiled");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-zinc-700 dark:text-zinc-300">{current}</span>
      {asset.folder ? <button type="button" onClick={unfile} className="rounded border border-zinc-300 px-2 py-0.5 text-xs dark:border-zinc-700">Unfile</button> : null}
    </div>
  );
}

function TagsField({ adapter, asset, onChanged }: { adapter: ReturnType<typeof createConsoleAdapter>; asset: MediaAssetDetail; onChanged: () => void }): ReactNode {
  const initial = (asset.tags || []).map((t) => t.name).join(", ");
  const [value, setValue] = useState(initial);
  useEffect(() => setValue(initial), [initial]);
  const save = async () => {
    const wanted = value.split(",").map((s) => s.trim()).filter(Boolean);
    const currentNames = new Set((asset.tags || []).map((t) => t.name));
    const add = wanted.filter((n) => !currentNames.has(n));
    const remove = (asset.tags || []).filter((t) => !wanted.includes(t.name)).map((t) => t.id);
    try {
      await adapter.setTags(asset.id, add, remove);
      toast.success("Tags saved");
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
  };
  return (
    <div className="space-y-1">
      <input type="text" value={value} onChange={(e) => setValue(e.target.value)} placeholder="comma, separated, tags" aria-label="Folder tags" className="w-full rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
      <button type="button" disabled={value === initial} onClick={save} className="rounded bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900">Save tags</button>
    </div>
  );
}

function UsagePanel({ asset, adapter }: { asset: MediaAssetDetail; adapter: ReturnType<typeof createConsoleAdapter> }): ReactNode {
  const [items, setItems] = useState<{ id: number; title: string; type: string; status: string; link: string }[] | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adapter.usage(asset.id, 1);
      setItems(res.items ? [...res.items] : []);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [adapter, asset.id]);
  if (asset.usage_count === 0) return <p className="text-xs text-zinc-500">Not used anywhere — safe to delete.</p>;
  return (
    <div className="space-y-1 text-xs">
      <p className="text-zinc-600 dark:text-zinc-400">Used in {asset.usage_count}{asset.usage_count >= 200 ? "+" : ""} place(s).</p>
      {items === null ? (
        <button type="button" disabled={loading} onClick={load} className="rounded border border-zinc-300 px-2 py-0.5 dark:border-zinc-700">{loading ? "Loading…" : "Show where"}</button>
      ) : (
        <ul className="ml-4 list-disc">
          {items.map((it) => (
            <li key={it.id}><a href={it.link} target="_blank" rel="noopener" className="text-sky-600 hover:underline">{it.title || `#${it.id}`}</a> <span className="text-zinc-400">({it.type})</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Actions({ adapter, asset, onClose, onNavigate }: { adapter: ReturnType<typeof createConsoleAdapter>; asset: MediaAssetDetail; onClose: () => void; onNavigate: () => void }): ReactNode {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const del = async () => {
    setBusy(true);
    try {
      const res = await adapter.del(asset.id);
      if (res.ok) {
        toast.success(res.bucket_removed ? "Deleted (file, thumbnails and bucket copy removed)" : "Deleted permanently");
        onNavigate();
        onClose();
      } else {
        toast.error(res.reason || "Could not delete");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not delete");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <a href={asset.url} target="_blank" rel="noopener" className="text-sky-600 hover:underline">View media file</a>
        <a href={`/wp-admin/post.php?post=${asset.id}&action=edit`} target="_blank" rel="noopener" className="text-sky-600 hover:underline">Edit more details</a>
        <a href={asset.url} download={asset.filename || ""} className="text-sky-600 hover:underline">Download file</a>
      </div>
      {confirming ? (
        <div className="rounded border border-red-300 bg-red-50 p-2 dark:border-red-800 dark:bg-red-950/30">
          <p className="text-red-700 dark:text-red-300">Delete “{asset.filename || asset.id}” permanently? This deletes the file and its thumbnails from the site — this is NOT the folder delete, which never touches files.{asset.offload?.status === "offloaded" ? " The bucket copy is removed too." : ""}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={busy} onClick={del} className="rounded bg-red-600 px-2.5 py-1 font-medium text-white disabled:opacity-40">{busy ? "Deleting…" : "Delete permanently"}</button>
            <button type="button" onClick={() => setConfirming(false)} className="rounded border border-zinc-300 px-2.5 py-1 dark:border-zinc-700">Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className="text-red-600 hover:underline">Delete permanently</button>
      )}
    </div>
  );
}

// ── Edit Image mode (WP_Image_Editor via media.edit) ───────────────────────────
function EditImage({ adapter, asset, onChanged }: { adapter: ReturnType<typeof createConsoleAdapter>; asset: MediaAssetDetail; onChanged: () => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const [ops, setOps] = useState<MediaEditParams["ops"]>([]);
  const [busy, setBusy] = useState(false);
  const editable = asset.edit?.editable && asset.edit?.editor_available;
  if (!editable) return <p className="text-xs text-zinc-500">This file can’t be edited here.</p>;
  const add = (op: MediaEditParams["ops"][number]) => setOps((prev) => [...prev, op].slice(0, 10));
  const apply = async () => {
    if (!ops.length) return;
    setBusy(true);
    try {
      const res = await adapter.edit(asset.id, ops, "all", true);
      if (res.ok) {
        toast.success("Image edited — thumbnails regenerated" + (res.optimizer_cleared ? " (re-optimize to make it lossless again)" : ""));
        setOps([]);
        setOpen(false);
        onChanged();
      } else {
        toast.error(res.reason === "offloaded-refused" ? "Restore from CDN before editing." : res.reason || "Edit failed");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Edit failed");
    } finally {
      setBusy(false);
    }
  };
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="rounded border border-zinc-300 px-2.5 py-1 text-xs font-medium dark:border-zinc-700">Edit Image</button>;
  const chip = "rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-700";
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={chip} onClick={() => add({ type: "rotate", angle: 90 })}>Rotate ↻</button>
        <button type="button" className={chip} onClick={() => add({ type: "rotate", angle: -90 })}>Rotate ↺</button>
        <button type="button" className={chip} onClick={() => add({ type: "flip", axis: "horizontal" })}>Flip H</button>
        <button type="button" className={chip} onClick={() => add({ type: "flip", axis: "vertical" })}>Flip V</button>
        {asset.width && asset.height ? (
          <button type="button" className={chip} onClick={() => add({ type: "scale", width: Math.round(asset.width / 2), height: Math.round(asset.height / 2) })}>Scale 50%</button>
        ) : null}
      </div>
      <p className="text-[11px] text-zinc-500">{ops.length ? `${ops.length} pending op(s)` : "Pick operations, then Apply."}</p>
      <div className="flex gap-2">
        <button type="button" disabled={busy || !ops.length} onClick={apply} className="rounded bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900">{busy ? "Applying…" : "Apply"}</button>
        <button type="button" onClick={() => { setOps([]); setOpen(false); }} className="rounded border border-zinc-300 px-2.5 py-1 text-xs dark:border-zinc-700">Cancel</button>
      </div>
    </div>
  );
}
