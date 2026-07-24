"use client";

/**
 * Page-cache zone (US-3/5/6/8/9) — the biggest lever, made operable from the
 * console. It leads with the hit-rate headline (is the cache earning its keep?),
 * then the enable switch, purge-all + warm, and the TTL + exclusion rules. A
 * foreign drop-in is explained as a conflict with no destructive option; a
 * non-writable wp-config surfaces its manual step instead of failing silently.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Cloud, Flame, HardDrive, Sparkles, Trash2 } from "lucide-react";
import { StatTile, healthTone } from "../../demo/widgets";
import { Pill } from "../../demo/manage/kit";
import { BTN, BTN_PRIMARY, INPUT } from "../../demo/manage/manage-ui";
import { Spinner } from "../../demo/manage/panel-shell";
import { cn } from "@/lib/utils";
import type { PageCacheStatus } from "../../../lib/manage/performance";
import { cacheVerdict, formatBytes } from "../../../lib/manage/performance-view";
import { Toggle } from "./perf-toggle";

export interface PageCacheControlsProps {
  readonly status: PageCacheStatus;
  readonly busy: string | null;
  readonly onToggle: (on: boolean) => void;
  readonly onPurgeAll: () => void;
  readonly onWarm: () => void;
  readonly onSaveConfig: (ttl: number, exclusions: string[]) => void;
}

/** Split a textarea of one-pattern-per-line into a trimmed, non-empty list. */
export function parseExclusions(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function PageCacheControls({
  status,
  busy,
  onToggle,
  onPurgeAll,
  onWarm,
  onSaveConfig,
}: PageCacheControlsProps): ReactNode {
  const verdict = cacheVerdict(status);
  const [ttl, setTtl] = useState<number>(status.ttl);
  const [exclusions, setExclusions] = useState<string>(status.exclusions.join("\n"));

  // Keep the editable fields in sync when a fresh status arrives (after save/purge).
  useEffect(() => {
    setTtl(status.ttl);
    setExclusions(status.exclusions.join("\n"));
  }, [status.ttl, status.exclusions]);

  if (verdict.foreignDropin) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-amber-400/30 bg-amber-400/5 p-4 text-sm">
        <Cloud className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
        <p className="text-zinc-700 dark:text-zinc-300">
          Another cache plugin owns <code className="font-mono text-xs">advanced-cache.php</code>. The built-in Page Cache
          will not overwrite it — deactivate the other plugin first if you want to use ours.
        </p>
      </div>
    );
  }

  const dirty = ttl !== status.ttl || parseExclusions(exclusions).join("\n") !== status.exclusions.join("\n");
  const canWarm = status.enabled;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <StatTile label="Hit rate (today)" value={verdict.hitRate} suffix="%" icon={Flame} tone={healthTone(verdict.hitRate)} />
        <StatTile label="Hit rate (7 days)" value={status.hit_rate_7d} suffix="%" icon={Sparkles} tone={healthTone(status.hit_rate_7d)} />
        <StatTile label="Cached pages" value={status.entries} icon={HardDrive} tone={healthTone(status.entries > 0 ? 90 : 40)} />
        <StatTile label="Cache size" value={Math.round(status.total_bytes / 1024)} suffix=" KB" icon={HardDrive} tone={healthTone(80)} />
      </div>

      <div className={cn("rounded-xl border p-3", verdict.tone === "good" ? "border-emerald-500/30 bg-emerald-500/5" : "border-zinc-200 dark:border-zinc-800")}>
        <Toggle
          label="Page cache"
          checked={status.enabled}
          disabled={busy !== null}
          onChange={onToggle}
          impact={verdict.label}
          note={
            !status.wp_config_writable && !status.enabled ? (
              <Pill tone="warn">wp-config not writable — enabling needs a manual step</Pill>
            ) : status.dropin_stale ? (
              <Pill tone="info">Drop-in is out of date — re-save settings to refresh it</Pill>
            ) : null
          }
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN} disabled={busy !== null || status.entries === 0} onClick={onPurgeAll} title="Clear all cached pages">
          {busy === "purge-all" ? <Spinner /> : <Trash2 className="h-4 w-4" aria-hidden />} Clear cache
        </button>
        <button type="button" className={BTN} disabled={busy !== null || !canWarm} onClick={onWarm} title="Pre-fill the cache for your most-visited pages">
          {busy === "warm" ? <Spinner /> : <Flame className="h-4 w-4" aria-hidden />} Warm cache
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Cache lifetime (seconds)</span>
          <input
            type="number"
            min={600}
            max={86400}
            step={60}
            value={ttl}
            onChange={(e) => setTtl(Number(e.target.value))}
            className={INPUT}
          />
          <span className="text-[11px] text-zinc-400">600–86400s. How long a page stays cached before it is rebuilt.</span>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Never cache these paths</span>
          <textarea
            rows={3}
            value={exclusions}
            onChange={(e) => setExclusions(e.target.value)}
            placeholder={"/checkout\n/members/*"}
            className={cn(INPUT, "font-mono text-xs")}
          />
          <span className="text-[11px] text-zinc-400">One path per line. Prefix or trailing-* only (e.g. /members/*).</span>
        </label>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          className={BTN_PRIMARY}
          disabled={busy !== null || !dirty}
          onClick={() => onSaveConfig(ttl, parseExclusions(exclusions))}
        >
          {busy === "configure" ? <Spinner /> : null} Save cache settings
        </button>
      </div>
    </div>
  );
}
