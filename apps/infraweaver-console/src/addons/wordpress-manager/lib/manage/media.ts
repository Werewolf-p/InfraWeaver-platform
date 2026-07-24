/**
 * Media fusion — the console-side TYPES + zod request validators for the seven
 * signed `media.*` commands. Isomorphic (no `server-only`): the API route parses
 * requests through these schemas, and the client narrows responses against these
 * types. Every bound + enum vocabulary MIRRORS the connector's
 * `IWSL_Media_Library` validators so the two sides can never drift — a request
 * this module accepts is one the plugin's validator also accepts.
 *
 * The read-model row is the JOIN the flagship Explorer renders: one asset with
 * its folder, its lossless/optimization state, and its offload ("on CDN") state
 * in a single shape, straight off `media.list`.
 */

import { z } from "zod";

// ── bounds (mirror IWSL_Media_Library constants; keep in lockstep) ────────────
export const PER_PAGE_MAX = 100;
export const PER_PAGE_DEFAULT = 60;
/** Optimizer batch per signed `media.optimize` call (IWSL_Media_Optimizer::MAX_BATCH). */
export const OPTIMIZE_BATCH = 10;
/** `media.optimize` id-list cap (the console loops chunks for larger sets). */
export const OPTIMIZE_REQUEST_MAX = 200;
/** `media.offload` / `media.restore` id-list cap. */
export const BULK_MAX = 50;
/** `media.folder` assign/tag id-list cap. */
export const FOLDER_IDS_MAX = 200;
export const TAG_IDS_MAX = 100;
export const SEARCH_MAX = 200;
export const NAME_MAX = 100;
/** Upper bound on ids the server returns for select-all-matching in one call. */
export const MATCH_IDS_MAX = 1500;

// ── enum vocabularies (first entry = safe default) ────────────────────────────
export const MIME_GROUPS = ["all", "image", "video", "audio", "document"] as const;
export const OPTIMIZATION_FILTERS = ["all", "optimized", "unoptimized"] as const;
export const OFFLOAD_FILTERS = ["all", "offloaded", "local"] as const;
export const ORDER_BYS = ["date", "title", "filename", "size"] as const;
export const ORDERS = ["desc", "asc"] as const;

export type MimeGroup = (typeof MIME_GROUPS)[number];
export type OptimizationFilter = (typeof OPTIMIZATION_FILTERS)[number];
export type OffloadFilter = (typeof OFFLOAD_FILTERS)[number];
export type MediaOrderBy = (typeof ORDER_BYS)[number];
export type MediaOrder = (typeof ORDERS)[number];

// ── read-model row shape (the fused JOIN) ─────────────────────────────────────
export type OptimizationStatus = "optimized" | "original" | "ineligible";
export type OffloadStatus = "offloaded" | "local";

export interface MediaOptimization {
  readonly status: OptimizationStatus;
  readonly converter: string | null;
  readonly bytes_in: number | null;
  readonly bytes_out: number | null;
  readonly saved_pct: number | null;
  readonly restorable: boolean;
}

export interface MediaOffload {
  readonly status: OffloadStatus;
  readonly variant: "derivative" | "original" | null;
  readonly url: string | null;
}

export interface MediaFolderRef {
  readonly id: number;
  readonly name: string;
}

export interface MediaTag {
  readonly id: number;
  readonly name: string;
}

export interface MediaAsset {
  readonly id: number;
  readonly title: string;
  readonly filename: string;
  readonly mime: string;
  readonly url: string;
  readonly thumb: string;
  readonly date: string;
  readonly filesize: number;
  readonly width: number;
  readonly height: number;
  readonly folder: MediaFolderRef | null;
  readonly tags: readonly MediaTag[];
  readonly optimization: MediaOptimization | null;
  readonly offload: MediaOffload | null;
}

export interface MediaFeatures {
  readonly media_folders: boolean;
  readonly image_optimization: boolean;
  readonly cdn_rewrite: boolean;
}

/** The gate descriptor the connector returns for a locked feature. */
export interface MediaGate {
  readonly unlocked?: boolean;
  readonly reason?: string;
  readonly tier?: string;
}

export interface MediaListResponse {
  readonly page: number;
  readonly per_page: number;
  readonly total: number;
  readonly pages: number;
  readonly locked: boolean;
  readonly features: MediaFeatures;
  readonly filters: { readonly optimization: OptimizationFilter; readonly offload: OffloadFilter };
  readonly items: readonly MediaAsset[];
  /** Present only when `include_ids` was requested — the select-all-matching set. */
  readonly ids?: readonly number[];
  /** True when more than MATCH_IDS_MAX matched (console pages the filter for the rest). */
  readonly ids_capped?: boolean;
  readonly gate?: MediaGate;
}

export interface MediaFolderNode {
  readonly id: number;
  readonly name: string;
  readonly parent: number;
  readonly count: number;
  readonly order: number;
  readonly depth: number;
}

export interface MediaTree {
  readonly folders: readonly MediaFolderNode[];
  readonly counts: { readonly all: number; readonly unfiled: number };
  readonly tags: readonly (MediaTag & { readonly count: number })[];
}

export interface MediaTreeResponse {
  readonly locked: boolean;
  readonly tree?: MediaTree;
  readonly gate?: MediaGate;
}

export interface MediaStatusResponse {
  readonly locked: boolean;
  readonly optimization?: { readonly total: number; readonly optimized: number; readonly remaining: number };
  readonly offload?: { readonly qualifying: number; readonly offloaded: number; readonly remaining: number };
  readonly totals?: { readonly attachments: number };
  readonly non_lossless?: number;
  readonly not_offloaded?: number;
  readonly cdn_rewrite?: { readonly unlocked: boolean };
  readonly gate?: MediaGate;
}

// ── request validators (parity with the connector's validate_* methods) ───────

const idListSchema = (max: number) =>
  z.array(z.number().int().positive()).min(1).max(max);

/** `media.list` params — every field optional; strays refused (mirrors validate_list_params). */
export const mediaListParamsSchema = z
  .object({
    page: z.number().int().min(1).optional(),
    per_page: z.number().int().min(1).max(PER_PAGE_MAX).optional(),
    folder_id: z.number().int().min(-1).optional(),
    search: z.string().max(SEARCH_MAX).optional(),
    mime_group: z.enum(MIME_GROUPS).optional(),
    tag_ids: z.array(z.number().int().positive()).max(TAG_IDS_MAX).optional(),
    orderby: z.enum(ORDER_BYS).optional(),
    order: z.enum(ORDERS).optional(),
    optimization: z.enum(OPTIMIZATION_FILTERS).optional(),
    offload: z.enum(OFFLOAD_FILTERS).optional(),
    include_ids: z.boolean().optional(),
  })
  .strict();

export type MediaListParams = z.infer<typeof mediaListParamsSchema>;

/** `media.optimize` params (mirrors validate_optimize_params). */
export const mediaOptimizeParamsSchema = z
  .object({
    ids: idListSchema(OPTIMIZE_REQUEST_MAX),
    converter_id: z.string().regex(/^[a-z0-9_]{1,64}$/).optional(),
    mode: z.enum(["copy", "replace"]).optional(),
    rewrite: z.boolean().optional(),
    skip_optimized: z.boolean().optional(),
  })
  .strict();

export type MediaOptimizeParams = z.infer<typeof mediaOptimizeParamsSchema>;

/** `media.offload` params (mirrors validate_offload_params). */
export const mediaOffloadParamsSchema = z
  .object({ op: z.enum(["offload", "unoffload"]), ids: idListSchema(BULK_MAX) })
  .strict();

export type MediaOffloadParams = z.infer<typeof mediaOffloadParamsSchema>;

/** `media.restore` params (mirrors validate_restore_params). */
export const mediaRestoreParamsSchema = z.object({ ids: idListSchema(BULK_MAX) }).strict();

export type MediaRestoreParams = z.infer<typeof mediaRestoreParamsSchema>;

const folderName = z.string().trim().min(1).max(NAME_MAX);

/** `media.folder` params — discriminated by `op` (mirrors validate_folder_params). Terms only. */
export const mediaFolderParamsSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), name: folderName, parent: z.number().int().min(0).optional() }).strict(),
  z.object({ op: z.literal("rename"), id: z.number().int().positive(), name: folderName }).strict(),
  z
    .object({ op: z.literal("move"), id: z.number().int().positive(), parent: z.number().int().min(0), order: z.number().int().optional() })
    .strict(),
  z.object({ op: z.literal("delete"), id: z.number().int().positive() }).strict(),
  z
    .object({ op: z.literal("assign"), ids: idListSchema(FOLDER_IDS_MAX), folder_id: z.number().int().min(0) })
    .strict(),
  z
    .object({
      op: z.literal("tag"),
      ids: idListSchema(FOLDER_IDS_MAX),
      add: z.array(folderName).max(FOLDER_IDS_MAX).optional(),
      remove: z.array(z.number().int().positive()).max(FOLDER_IDS_MAX).optional(),
    })
    .strict(),
]);

export type MediaFolderParams = z.infer<typeof mediaFolderParamsSchema>;

/** The write verbs the dedicated media route dispatches (signed method per verb). */
export const MEDIA_WRITE_VERBS = ["optimize", "offload", "restore", "folder", "updateMeta", "edit", "protect", "delete"] as const;
export type MediaWriteVerb = (typeof MEDIA_WRITE_VERBS)[number];

/** The read verbs (GET) the media route serves. */
export const MEDIA_READ_VERBS = ["list", "tree", "status", "get", "usage"] as const;
export type MediaReadVerb = (typeof MEDIA_READ_VERBS)[number];

// ── viewer detail (Agent A) — the click-to-open viewer read-model + mutations ──
// Every shape MIRRORS the connector's IWSL_Media_Detail / IWSL_Media_Editor /
// IWSL_Media_Protection validators so the two sides can never drift.

export interface MediaSize {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly url: string;
}

export interface MediaUploader {
  readonly id: number;
  readonly name: string;
}

/** The full viewer detail = the fused list row + the native attachment-panel fields. */
export interface MediaAssetDetail extends MediaAsset {
  readonly alt: string;
  readonly caption: string;
  readonly description: string;
  readonly uploader: MediaUploader;
  /** `post_modified_gmt` — the optimistic-concurrency token (echo it as expect_modified). */
  readonly modified: string;
  readonly sizes: readonly MediaSize[];
  readonly exif: Record<string, string | number> | null;
  readonly protected: boolean;
  readonly usage_count: number;
  readonly edit: { readonly editable: boolean; readonly editor_available: boolean };
}

export interface MediaGetResponse {
  readonly locked: boolean;
  readonly found?: boolean;
  readonly features?: MediaFeatures;
  readonly asset?: MediaAssetDetail | null;
  readonly gate?: MediaGate;
}

export interface MediaUpdateMetaResponse {
  readonly ok: boolean;
  readonly updated?: boolean;
  readonly conflict?: boolean;
  readonly locked?: boolean;
  readonly reason?: string;
  readonly asset?: { alt: string; title: string; caption: string; description: string; modified: string };
  readonly current?: { alt: string; title: string; caption: string; description: string; modified: string };
  readonly gate?: MediaGate;
}

export interface MediaEditResponse {
  readonly ok: boolean;
  readonly edited?: boolean;
  readonly id?: number;
  readonly reason?: string;
  readonly width?: number;
  readonly height?: number;
  readonly filesize?: number;
  readonly optimizer_cleared?: boolean;
  readonly locked?: boolean;
  readonly gate?: MediaGate;
}

export interface MediaProtectResponse {
  readonly ok: boolean;
  readonly locked?: boolean;
  readonly changed?: number;
  readonly protected?: boolean;
  readonly results?: ReadonlyArray<{ id: number; protected: boolean }>;
  readonly gate?: MediaGate;
}

export interface MediaDeleteResponse {
  readonly ok: boolean;
  readonly deleted?: boolean;
  readonly id?: number;
  readonly bucket_removed?: boolean;
  readonly locked?: boolean;
  readonly reason?: string;
  readonly gate?: MediaGate;
}

export interface MediaUsageItem {
  readonly id: number;
  readonly title: string;
  readonly type: string;
  readonly status: string;
  readonly link: string;
}

export interface MediaUsageResponse {
  readonly locked: boolean;
  readonly items?: readonly MediaUsageItem[];
  readonly total?: number;
  readonly page?: number;
  readonly pages?: number;
  readonly capped?: boolean;
  readonly gate?: MediaGate;
}

// ── viewer request validators (parity with the connector's validate_* methods) ─

/** `media.get` — EXACTLY { id }. */
export const mediaGetParamsSchema = z.object({ id: z.number().int().positive() }).strict();
export type MediaGetParams = z.infer<typeof mediaGetParamsSchema>;

/** `media.usage` — { id, page? }. */
export const mediaUsageParamsSchema = z
  .object({ id: z.number().int().positive(), page: z.number().int().min(1).optional() })
  .strict();
export type MediaUsageParams = z.infer<typeof mediaUsageParamsSchema>;

/** `media.updateMeta` — id + expect_modified + at least one editable field. */
export const mediaUpdateMetaParamsSchema = z
  .object({
    id: z.number().int().positive(),
    expect_modified: z.string().max(64),
    alt: z.string().max(500).optional(),
    title: z.string().max(300).optional(),
    caption: z.string().max(20000).optional(),
    description: z.string().max(20000).optional(),
  })
  .strict()
  .refine(
    (p) => p.alt !== undefined || p.title !== undefined || p.caption !== undefined || p.description !== undefined,
    { message: "at least one editable field is required" },
  );
export type MediaUpdateMetaParams = z.infer<typeof mediaUpdateMetaParamsSchema>;

/** `media.edit` op shapes (discriminated by type) — mirror IWSL_Media_Editor::valid_op. */
export const EDIT_OPS_MAX = 10;
const rotateOp = z
  .object({ type: z.literal("rotate"), angle: z.number().int().refine((a) => a !== 0 && a % 90 === 0 && a >= -360 && a <= 360, "angle must be a non-zero multiple of 90") })
  .strict();
const flipOp = z.object({ type: z.literal("flip"), axis: z.enum(["horizontal", "vertical"]) }).strict();
const cropOp = z
  .object({ type: z.literal("crop"), x: z.number().int().min(0), y: z.number().int().min(0), width: z.number().int().positive(), height: z.number().int().positive() })
  .strict();
const scaleOp = z.object({ type: z.literal("scale"), width: z.number().int().positive(), height: z.number().int().positive() }).strict();

export const mediaEditParamsSchema = z
  .object({
    id: z.number().int().positive(),
    ops: z.array(z.discriminatedUnion("type", [rotateOp, flipOp, cropOp, scaleOp])).min(1).max(EDIT_OPS_MAX),
    target: z.enum(["all", "thumbnail"]).optional(),
    regenerate: z.boolean().optional(),
  })
  .strict();
export type MediaEditParams = z.infer<typeof mediaEditParamsSchema>;

/** `media.protect` — { ids (1..BULK_MAX), protected }. */
export const mediaProtectParamsSchema = z
  .object({ ids: idListSchema(BULK_MAX), protected: z.boolean() })
  .strict();
export type MediaProtectParams = z.infer<typeof mediaProtectParamsSchema>;

/** `media.delete` — { id, confirm } where confirm is the LITERAL true (a destructive fence). */
export const mediaDeleteParamsSchema = z.object({ id: z.number().int().positive(), confirm: z.literal(true) }).strict();
export type MediaDeleteParams = z.infer<typeof mediaDeleteParamsSchema>;
