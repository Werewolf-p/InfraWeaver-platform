"use client";
// Media panel — uploads library size, attachment count, a top-level MIME
// breakdown and the largest upload folders, all read live from the pod. There is
// no allow-listed media mutation, so this panel is a read-only report.

import { FolderOpen, HardDrive, Image as ImageIcon, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MediaData, MimeBucket } from "../../../lib/manage/probes/media";
import { SectionCard, StatTile } from "../widgets";
import { PanelState } from "./panel-shell";
import { useManagePanel } from "./use-manage";

// Bar colour per top-level MIME type; unknowns fall back to zinc.
const MIME_BAR: Record<string, string> = {
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

export function MediaPanel({ site }: { site: string }) {
  const state = useManagePanel<MediaData>(site, "media");

  return (
    <PanelState state={state}>
      {(data) => (
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="grid gap-3 sm:grid-cols-3 lg:col-span-2">
            <StatTile label="Library items" value={data.total} icon={ImageIcon} />
            <StatTile label="Uploads size" value={data.uploadsMb ?? 0} suffix=" MB" icon={HardDrive} />
            <StatTile label="Upload folders" value={data.largestDirs.length} icon={FolderOpen} />
          </div>

          <SectionCard
            title="Media types"
            description={
              data.sampled >= data.total || data.total === 0
                ? "Attachments grouped by top-level type."
                : `Grouped by top-level type — sampled ${data.sampled} of ${data.total} attachments.`
            }
            icon={Layers}
          >
            {data.mime.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
                No attachments found.
              </div>
            ) : (
              <ul className="space-y-3">
                {data.mime.map((bucket) => (
                  <MimeRow key={bucket.kind} bucket={bucket} sampled={data.sampled} />
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            title="Largest upload folders"
            description="The heaviest sub-directories under wp-content/uploads."
            icon={HardDrive}
          >
            {data.largestDirs.length === 0 ? (
              <div className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
                No upload folders to measure.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                      <th className="py-2 pr-4 font-medium">Folder</th>
                      <th className="py-2 text-right font-medium">Size</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
                    {data.largestDirs.map((entry) => (
                      <tr key={entry.dir} className="text-zinc-700 dark:text-zinc-300">
                        <td className="py-2 pr-4 font-mono text-[11px]">{entry.dir}</td>
                        <td className="py-2 text-right tabular-nums">{entry.mb} MB</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </div>
      )}
    </PanelState>
  );
}
