/**
 * Bulk-action definitions for the fused Media Explorer + the pure helpers that
 * turn a signed batch reply into a ledger outcome. The Explorer feeds selected
 * asset ids to these actions in bounded batches (chunked at OPTIMIZE_BATCH) via
 * the shared `BulkActionBar` + `RunLedger`, so a 1500-asset "make lossless" run is
 * a loop of small signed calls with live progress — never one unbounded command.
 */

import { Sparkles, UploadCloud, RotateCcw } from "lucide-react";
import type { BulkActionMeta } from "../kit/bulk-bar";
import type { ItemOutcome } from "../../../lib/manage/run-ledger";
import { chunkIds } from "../../../lib/manage/media-batch";
import { OPTIMIZE_BATCH, type MediaWriteVerb } from "../../../lib/manage/media";

/** The bulk verbs the action bar offers, mapped to their signed write verb. */
export type MediaBulkActionId = "make-lossless" | "offload" | "restore";

export const MEDIA_BULK_VERB: Record<MediaBulkActionId, MediaWriteVerb> = {
  "make-lossless": "optimize",
  offload: "offload",
  restore: "restore",
};

/** The action bar meta (labels/icons/confirm copy). Restore confirms (it moves bytes). */
export const MEDIA_BULK_ACTIONS: readonly BulkActionMeta[] = [
  { id: "make-lossless", label: "Make lossless", icon: Sparkles },
  { id: "offload", label: "Offload to CDN", icon: UploadCloud },
  {
    id: "restore",
    label: "Restore original",
    icon: RotateCcw,
    confirm: true,
    confirmTitle: (count) => `Restore ${count} asset(s) to their original?`,
    description: "Brings offloaded assets back local (download-verified before the remote copy is dropped). Never deletes the last copy.",
  },
];

/** Split selected asset ids into consecutive batches of at most OPTIMIZE_BATCH. */
export function batchAssetIds(ids: readonly number[]): number[][] {
  return chunkIds(ids, OPTIMIZE_BATCH);
}

/** Stable ledger key for a batch index (the fan-out unit BulkActionBar tracks). */
export function batchKey(index: number): string {
  return `b${index}`;
}

/** Human label for a batch key given its resolved size (drives the ledger row text). */
export function batchLabel(size: number, offset: number): string {
  const start = offset + 1;
  const end = offset + size;
  return size === 1 ? `asset ${start}` : `assets ${start}–${end}`;
}

/**
 * Interpret a signed batch reply into a ledger outcome. A `locked` reply (the tier
 * lost the entitlement mid-run) is a failure with the gate reason; an optimizer
 * `partial` batch still counts as ok (the next loop iteration picks up the rest).
 */
export function outcomeFromWrite(verb: MediaWriteVerb, result: unknown): ItemOutcome {
  const r = (result ?? {}) as {
    locked?: boolean;
    gate?: { reason?: string };
    result?: { ok?: boolean; converted?: number; failed?: number; skipped?: number };
    summary?: { ok?: number; failed?: number };
  };
  if (r.locked) return { ok: false, message: r.gate?.reason ?? "Locked on this plan" };

  if (verb === "restore") {
    const failed = r.summary?.failed ?? 0;
    const ok = r.summary?.ok ?? 0;
    if (failed > 0 && ok === 0) return { ok: false, message: `${failed} failed` };
    return { ok: true, message: failed > 0 ? `${ok} ok, ${failed} skipped` : undefined };
  }

  // optimize / offload — the engine reports a per-batch run object.
  const run = r.result ?? {};
  const failed = run.failed ?? 0;
  if (failed > 0 && !(run.converted ?? 0)) return { ok: false, message: `${failed} failed` };
  return { ok: true };
}
