"use client";

/**
 * Column builder for the fused asset table — ONE row per asset carrying its
 * folder, its "Lossless" (optimization) pill and its "CDN" (offload) pill inline,
 * exactly the fusion the north-star asks for. Pure: it maps a `MediaAsset` to
 * cells via the tested `optimizationChip` / `offloadChip` mappers, no state.
 */

import type { ReactNode } from "react";
import { FileImage } from "lucide-react";
import type { Column } from "../../demo/manage/kit/data-table";
import { Pill } from "../../demo/manage/kit/pill";
import { offloadChip, optimizationChip } from "../../../lib/manage/media-batch";
import type { MediaAsset, MediaFeatures } from "../../../lib/manage/media";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function ThumbTitle({ asset }: { asset: MediaAsset }): ReactNode {
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md border border-zinc-200 bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-800">
        {asset.thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={asset.thumb} alt="" loading="lazy" className="h-full w-full object-cover" />
        ) : (
          <FileImage className="h-4 w-4 text-zinc-400" aria-hidden />
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {asset.title || asset.filename || `#${asset.id}`}
        </span>
        <span className="block truncate font-mono text-xs text-zinc-500 dark:text-zinc-400">
          {asset.filename} · {formatBytes(asset.filesize)}
        </span>
      </span>
    </div>
  );
}

/**
 * Build the asset table columns. Optimization/offload columns render only when the
 * site is entitled for `image_optimization` (the shared offload flag) — otherwise
 * the row still shows folder + basics with the paid columns blanked (never faked).
 */
export function buildAssetColumns(features: MediaFeatures): Column<MediaAsset>[] {
  const columns: Column<MediaAsset>[] = [
    {
      key: "asset",
      header: "Asset",
      primary: true,
      render: (asset) => <ThumbTitle asset={asset} />,
    },
    {
      key: "folder",
      header: "Folder",
      render: (asset) =>
        features.media_folders ? (
          <span className="text-sm text-zinc-600 dark:text-zinc-300">{asset.folder ? asset.folder.name : "Unfiled"}</span>
        ) : (
          <span className="text-zinc-400">—</span>
        ),
    },
  ];

  if (features.image_optimization) {
    columns.push({
      key: "cdn",
      header: "CDN",
      render: (asset) => {
        const chip = offloadChip(asset.offload);
        return <Pill tone={chip.tone}>{chip.label}</Pill>;
      },
    });
    columns.push({
      key: "lossless",
      header: "Lossless",
      render: (asset) => {
        const chip = optimizationChip(asset.optimization);
        return <Pill tone={chip.tone}>{chip.label}</Pill>;
      },
    });
  }

  return columns;
}
