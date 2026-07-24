/**
 * The viewer's PANEL REGISTRY — the single declarative option list the React viewer
 * renders. It MIRRORS the canonical framework-free registry in the connector
 * (`apps/infraweaver-wp-connector/includes/assets/iwsl-media-viewer.js` →
 * `PANEL_REGISTRY`) exactly as `lib/manage/media.ts` mirrors the connector's param
 * validators — one shape, two surfaces, kept in lockstep so the console viewer, the
 * plugin Explorer viewer and the native-modal viewer never diverge.
 *
 * kind:  detail (read-only) | field (editable) | action | toggle | panel (composed).
 * gate:  the entitlement flag a panel needs unlocked, or null (always shown).
 * verb:  the adapter method the panel drives, or null for pure reads.
 */

export type PanelKind = "detail" | "field" | "action" | "toggle" | "panel";
export type AdapterVerb =
  | "updateMeta"
  | "folderOp"
  | "protect"
  | "optimize"
  | "offload"
  | "restore"
  | "edit"
  | "usage"
  | null;

export interface PanelSpec {
  readonly id: string;
  readonly kind: PanelKind;
  readonly gate: "media_folders" | "image_optimization" | "media_protection" | null;
  readonly verb: AdapterVerb;
  readonly label: string;
  readonly multiline?: boolean;
  readonly help?: string;
}

/** The locked panel set, in render order — the reconciled ~28-line option list. */
export const VIEWER_PANELS: readonly PanelSpec[] = [
  { id: "edit", kind: "panel", gate: "image_optimization", verb: "edit", label: "Edit Image" },
  { id: "details", kind: "detail", gate: null, verb: null, label: "Details" },
  {
    id: "alt",
    kind: "field",
    gate: null,
    verb: "updateMeta",
    label: "Alternative Text",
    multiline: true,
    help: "Describe the purpose of the image. Leave empty if the image is purely decorative.",
  },
  { id: "title", kind: "field", gate: null, verb: "updateMeta", label: "Title" },
  { id: "caption", kind: "field", gate: null, verb: "updateMeta", label: "Caption", multiline: true },
  { id: "description", kind: "field", gate: null, verb: "updateMeta", label: "Description", multiline: true },
  { id: "fileurl", kind: "detail", gate: null, verb: null, label: "File URL" },
  { id: "optimization", kind: "panel", gate: "image_optimization", verb: "optimize", label: "Optimization" },
  { id: "offload", kind: "panel", gate: "image_optimization", verb: "offload", label: "CDN / Offload" },
  {
    id: "protect",
    kind: "toggle",
    gate: "media_protection",
    verb: "protect",
    label: "Protect this image (discourage copying)",
    help: "Deterrent only — discourages casual right-click / drag saving. This is not DRM; a determined visitor can still capture pixels.",
  },
  { id: "folder", kind: "field", gate: "media_folders", verb: "folderOp", label: "Folder", help: "A file lives in at most one folder." },
  { id: "tags", kind: "field", gate: "media_folders", verb: "folderOp", label: "Folder tags" },
  { id: "usage", kind: "panel", gate: null, verb: "usage", label: "Where used" },
  { id: "actions", kind: "action", gate: null, verb: null, label: "Actions" },
] as const;

export interface ViewerFeatures {
  readonly media_folders: boolean;
  readonly image_optimization: boolean;
  readonly media_protection?: boolean;
}

/** Whether a panel's gate is satisfied (else it renders disabled-with-reason). */
export function isPanelUnlocked(panel: PanelSpec, features: ViewerFeatures): boolean {
  if (!panel.gate) return true;
  const map: Record<NonNullable<PanelSpec["gate"]>, boolean | undefined> = {
    media_folders: features.media_folders,
    image_optimization: features.image_optimization,
    media_protection: features.media_protection,
  };
  return Boolean(map[panel.gate]);
}

/** Bytes → a compact human string (shared with the JS core's formatBytes). */
export function formatBytes(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Zoom bounds (mirror the JS core). */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8;
export const ZOOM_STEP = 1.4;

export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** Pure next-zoom for a control intent (shared semantics with the JS core). */
export function nextZoom(current: number, intent: "zoomIn" | "zoomOut" | "zoomReset" | "toggle"): number {
  if (intent === "zoomReset") return ZOOM_MIN;
  if (intent === "zoomIn") return clampZoom(current * ZOOM_STEP);
  if (intent === "zoomOut") return clampZoom(current / ZOOM_STEP);
  return current > ZOOM_MIN ? ZOOM_MIN : 2;
}
