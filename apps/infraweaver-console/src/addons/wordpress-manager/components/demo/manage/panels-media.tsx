"use client";
// Media panel — uploads library size, attachment count, a top-level MIME
// breakdown and the largest upload folders, all read live from the pod. There is
// no allow-listed media mutation, so this panel is a READ-ONLY report: it renders
// no action buttons and never implies a delete/cleanup verb it can't perform.
// Built on the Manage design-system kit (`./kit`): folders are a `DataTable` and
// the empty state is an `EmptyState`.

import { FolderOpen, HardDrive, Image as ImageIcon, Info, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MediaData, MimeBucket, UploadDir } from "../../../lib/manage/probes/media";
import { SectionCard, StatTile } from "../widgets";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";
import { DataTable, EmptyState } from "./kit";
import type { Column } from "./kit";

// Bar colour per top-level MIME type; unknowns fall back to zinc.
const MIME_BAR: Readonly<Record<string, string>> = {
  image: "bg-sky-500",
  video: "bg-violet-500",
  audio: "bg-amber-500",
  application: "bg-emerald-500",
};
function barColor(kind: string): string {
  return MIME_BAR[kind] ?? "bg-zinc-400 dark:bg-zinc-500";
}

function MimeRow({ bucket, sampled }: { bucket: MimeBucket; sampled: number }) {
  const pct = sampled > 0 ? (bucket.count / sampled) * 100 : 0;
  return (
    <li>
      <div className="flex items-center justify-between text-sm">
        <span className="capitalize text-zinc-700 dark:text-zinc-300">{bucket.kind}</span>
        <span className="tabular-nums text-zinc-500 dark:text-zinc-400">{bucket.count}</span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div className={cn("h-full rounded-full", barColor(bucket.kind))} style={{ width: `${pct}%` }} aria-hidden />
      </div>
    </li>
  );
}

// Largest upload folders → shared DataTable (folder left, size right-aligned).
const DIR_COLUMNS: readonly Column<UploadDir>[] = [
  {
    key: "dir",
    header: "Folder",
    render: (entry) => <span className="font-mono text-[11px] text-zinc-700 dark:text-zinc-300">{entry.dir}</span>,
  },
  {
    key: "mb",
    header: "Size",
    align: "right",
    render: (entry) => `${entry.mb} MB`,
    className: "font-mono text-[11px] text-zinc-600 dark:text-zinc-400",
  },
];

export function MediaPanel({ site }: { site: string }) {
  const state = useManagePanel<MediaData>(site, "media");

  return (
    <PanelState state={state}>
      {(data) => {
        // The MIME breakdown is drawn from a bounded sample; the exact library count
        // is measured separately. Whenever the sample is partial, say so honestly.
        const sampledPartial = data.sampled < data.total;
        return (
          <div className="grid gap-5 lg:grid-cols-2">
            <div className="grid gap-3 sm:grid-cols-3 lg:col-span-2">
              <StatTile label="Library items" value={data.total} icon={ImageIcon} />
              <StatTile label="Uploads size" value={data.uploadsMb ?? 0} suffix=" MB" icon={HardDrive} />
              <StatTile label="Upload folders" value={data.largestDirs.length} icon={FolderOpen} />
            </div>

            <p className="flex items-start gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600 lg:col-span-2 dark:border-zinc-800 dark:bg-zinc-950/40 dark:text-zinc-400">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden />
              Media is a read-only report — clean up large files inside WordPress.
            </p>

            <SectionCard title="Media types" description="Attachments grouped by top-level type." icon={Layers}>
              {data.mime.length === 0 ? (
                <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
                  No attachments found.
                </div>
              ) : (
                <>
                  <ul className="space-y-3">
                    {data.mime.map((bucket) => (
                      <MimeRow key={bucket.kind} bucket={bucket} sampled={data.sampled} />
                    ))}
                  </ul>
                  {sampledPartial ? (
                    <p className="mt-4 flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                      <Info className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden />
                      Types sampled from {data.sampled} of {data.total} attachments.
                    </p>
                  ) : null}
                </>
              )}
            </SectionCard>

            <SectionCard
              title="Largest upload folders"
              description="The heaviest sub-directories under wp-content/uploads."
              icon={HardDrive}
            >
              {data.largestDirs.length === 0 ? (
                <EmptyState
                  icon={FolderOpen}
                  title="No uploads yet."
                  body="Nothing has been added to this site's media library."
                />
              ) : (
                <DataTable
                  caption="Largest upload sub-directories under wp-content/uploads with their sizes"
                  columns={DIR_COLUMNS}
                  rows={data.largestDirs}
                  getRowKey={(entry, index) => `${entry.dir}:${index}`}
                />
              )}
            </SectionCard>
          </div>
        );
      }}
    </PanelState>
  );
}
