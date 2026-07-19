"use client";

// Media tab for the per-site "Manage" demo — library size, image optimization, largest files.
import { FileImage, HardDrive, Image as ImageIcon, TrendingDown, Wand2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import type { SiteManageExt } from "../site-manage-ext-data";
import { SectionCard, StatTile } from "../widgets";
import { DummyBadge } from "../DummyBadge";

type PillTone = "good" | "warn";
const PILL_BASE = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium";
const PILL: Record<PillTone, string> = {
  good: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warn: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
};
const BTN =
  "inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
const BTN_PRIMARY = "border-sky-500 bg-sky-500 text-white hover:bg-sky-600 dark:text-white";
const BTN_SM =
  "inline-flex items-center gap-1 rounded-lg border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800";
const TILE = "rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/40";

const demo = () => toast.info("Demo — no changes are made to the live site.");
const fmt = (n: number) => n.toLocaleString("en-US");

export function MediaPanel({ ext }: { ext: SiteManageExt; site: string }) {
  const { media } = ext;
  const totalScanned = media.optimized + media.unoptimized;
  const optimizedPct = totalScanned > 0 ? (media.optimized / totalScanned) * 100 : 0;

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="grid gap-3 sm:grid-cols-2 lg:col-span-2 lg:grid-cols-4">
        <StatTile label="Library items" value={media.libraryCount} icon={ImageIcon} />
        <StatTile label="Library size" value={media.librarySizeGb} decimals={2} suffix=" GB" icon={HardDrive} />
        <StatTile label="Saved" value={media.savedGb} decimals={2} suffix=" GB" icon={TrendingDown} />
        <StatTile label="WebP coverage" value={media.webpCoverage} suffix="%" icon={FileImage} />
      </div>

      <SectionCard
        title="Image optimization"
        description="Compress and convert media to shrink page weight."
        icon={ImageIcon}
        action={<DummyBadge />}
      >
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
          <div
            className="bg-emerald-500"
            style={{ width: `${optimizedPct}%` }}
            role="img"
            aria-label={`${Math.round(optimizedPct)}% of media optimized`}
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="text-emerald-600 dark:text-emerald-400">
            <span className="tabular-nums">{fmt(media.optimized)}</span> optimized
          </span>
          <span className="text-zinc-500 dark:text-zinc-400">
            <span className="tabular-nums">{fmt(media.unoptimized)}</span> remaining
          </span>
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className={TILE}>
            <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Average savings</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{media.savingsPct}%</p>
          </div>
          <div className={TILE}>
            <p className="text-xs font-medium text-zinc-600 dark:text-zinc-400">WebP coverage</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{media.webpCoverage}%</p>
          </div>
        </div>
        <div className="mt-4">
          <button type="button" onClick={demo} className={cn(BTN, BTN_PRIMARY)}>
            <Wand2 className="h-4 w-4" aria-hidden /> Optimize {fmt(media.unoptimized)} remaining
          </button>
        </div>
      </SectionCard>

      <SectionCard
        title="Largest files"
        description="The heaviest items in your media library."
        icon={HardDrive}
        action={<DummyBadge />}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 text-right font-medium">Size</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {media.largest.map((file, i) => (
                <tr key={`${file.name}-${i}`} className="text-zinc-700 dark:text-zinc-300">
                  <td className="py-2 pr-4 font-mono text-[11px]">{file.name}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{file.sizeMb} MB</td>
                  <td className="py-2 pr-4">
                    <span className={cn(PILL_BASE, PILL[file.optimized ? "good" : "warn"])}>
                      {file.optimized ? "Optimized" : "Not optimized"}
                    </span>
                  </td>
                  <td className="py-2 text-right">
                    {file.optimized ? null : (
                      <button type="button" onClick={demo} className={BTN_SM}>
                        <Wand2 className="h-3.5 w-3.5" aria-hidden /> Optimize
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>
    </div>
  );
}
