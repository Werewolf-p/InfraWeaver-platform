import { ExternalLink, Layers } from "lucide-react";

interface StagingBannerProps {
  /** The single shared staging/dev environment URL. */
  stagingUrl: string;
}

/**
 * Persistent header explaining the batched-staging model in one sentence and
 * offering the ONE shared "Open staging environment" link. Accepted fixes
 * accumulate on this single environment, so there is intentionally no confusing
 * per-entry preview button here.
 */
export function StagingBanner({ stagingUrl }: StagingBannerProps) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-indigo-200 bg-indigo-50/60 p-4 dark:border-indigo-500/20 dark:bg-indigo-500/5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2.5">
        <Layers className="mt-0.5 h-4 w-4 shrink-0 text-indigo-500 dark:text-indigo-300" />
        <p className="text-xs leading-relaxed text-indigo-900 dark:text-indigo-100">
          Approved fixes pile up on one shared staging environment — test them there, then Publish everything to live at
          once.
        </p>
      </div>
      <a
        href={stagingUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-indigo-300 bg-white px-3.5 py-2 text-xs font-semibold text-indigo-700 shadow-sm transition-colors hover:bg-indigo-50 dark:border-indigo-500/30 dark:bg-[#161616] dark:text-indigo-200 dark:hover:bg-indigo-500/10"
      >
        Open staging environment
        <ExternalLink className="h-3.5 w-3.5" />
      </a>
    </div>
  );
}

export default StagingBanner;
