/**
 * Media panel probe — uploads library size, attachment count, a top-level MIME
 * breakdown and the largest upload sub-directories, all read live from the pod.
 * The attachment count and MIME sample come from core wp-cli (WP_SAFE); the size
 * numbers come from `du` against `wp-content/uploads` (relative to the WordPress
 * root the exec already runs in). No mutations exist for this panel — it is a
 * read-only report, so the panel renders no action buttons.
 */
import { WP_SAFE, kvLine, parseKv, parseJsonArray, toInt, fieldStr } from "../wp-probe";
import type { PanelProbe, PanelProbeContext } from "./contract";

/** How many attachments to sample for the MIME breakdown (count is measured separately, exactly). */
const MIME_SAMPLE = 500;

export interface MimeBucket {
  /** Top-level MIME type: image | video | application | audio | other. */
  readonly kind: string;
  readonly count: number;
}

export interface UploadDir {
  readonly dir: string;
  readonly mb: number;
}

export interface MediaData {
  /** Exact attachment count. */
  readonly total: number;
  /** wp-content/uploads size in MB, or null when unreadable. */
  readonly uploadsMb: number | null;
  /** How many attachments the MIME breakdown sampled (≤ MIME_SAMPLE). */
  readonly sampled: number;
  readonly mime: readonly MimeBucket[];
  readonly largestDirs: readonly UploadDir[];
}

type MimeRow = {
  post_mime_type?: string;
};

/** Tally attachment rows by the part of the MIME type before the slash. */
function tallyMime(rows: readonly MimeRow[]): MimeBucket[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const mime = fieldStr(row, "post_mime_type");
    const kind = mime ? (mime.split("/")[0] || "other") : "other";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);
}

/** Parse `du -m` lines (`<mb>\t<path>`) into the largest upload sub-directories. */
function parseDirs(stdout: string): UploadDir[] {
  const dirs: UploadDir[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const mb = Number(match[1]);
    if (!Number.isFinite(mb)) continue;
    const path = match[2];
    const dir = path.split("/").filter(Boolean).pop() ?? path;
    dirs.push({ dir, mb });
  }
  return dirs;
}

export function parseMedia(input: { scalars: string; mime: string; dirs: string }): MediaData {
  const kv = parseKv(input.scalars);
  const mimeRows = parseJsonArray<MimeRow>(input.mime);

  return {
    total: toInt(kv.get("TOTAL")) ?? 0,
    uploadsMb: toInt(kv.get("UPLOADS_MB")),
    sampled: mimeRows.length,
    mime: tallyMime(mimeRows),
    largestDirs: parseDirs(input.dirs),
  };
}

async function fetchMedia(ctx: PanelProbeContext): Promise<MediaData> {
  const scalarsCmd = [
    kvLine("TOTAL", `${WP_SAFE} post list --post_type=attachment --format=count`),
    kvLine("UPLOADS_MB", `du -sm wp-content/uploads | cut -f1`),
  ].join("\n");

  const [scalars, mime, dirs] = await Promise.all([
    ctx.exec(scalarsCmd).then((r) => r.stdout).catch(() => ""),
    ctx
      .exec(`${WP_SAFE} post list --post_type=attachment --format=json --fields=post_mime_type --posts_per_page=${MIME_SAMPLE}`)
      .then((r) => r.stdout)
      .catch(() => "[]"),
    ctx
      .exec(`du -m wp-content/uploads/* 2>/dev/null | sort -rn | head -8`)
      .then((r) => r.stdout)
      .catch(() => ""),
  ]);

  return parseMedia({ scalars, mime, dirs });
}

export const mediaProbe: PanelProbe<MediaData> = {
  id: "media",
  fetch: fetchMedia,
};
