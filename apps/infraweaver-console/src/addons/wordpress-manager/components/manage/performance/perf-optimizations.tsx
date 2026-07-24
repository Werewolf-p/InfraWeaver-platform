"use client";

/**
 * Optimizations zone (US-10) — the fine levers: the speed-pack toggles and lazy
 * loading, each with a plain-language benefit and a risk chip where it matters
 * (delay_js keeps its "Advanced" warning). Flipping a toggle sends the COMPLETE
 * current settings with that one field changed, so the connector's sanitize step
 * never silently resets the other switches. Delegates every save to the parent.
 */

import { useState, type ReactNode } from "react";
import { Pill } from "../../demo/manage/kit";
import { INPUT } from "../../demo/manage/manage-ui";
import type { LazyLoadSettings, SpeedPackSettings, SpeedPackStatus, SpeedPackSwitch } from "../../../lib/manage/performance";
import { Toggle } from "./perf-toggle";

interface SwitchMeta {
  readonly key: SpeedPackSwitch;
  readonly label: string;
  readonly impact: string;
  readonly risk?: string;
}

/** The curated, owner-facing subset of speed-pack switches with plain impact copy. */
const SPEED_PACK_META: readonly SwitchMeta[] = [
  { key: "minify_html", label: "Minify HTML", impact: "Strip whitespace from pages to send fewer bytes." },
  { key: "defer_js", label: "Defer JavaScript", impact: "Load scripts after content so pages paint sooner." },
  { key: "delay_js", label: "Delay JavaScript", impact: "Hold non-critical scripts until the visitor interacts.", risk: "Advanced" },
  { key: "server_headers", label: "Compression & cache headers", impact: "Add gzip and browser-cache headers via .htaccess." },
  { key: "resource_hints", label: "Resource hints", impact: "Preconnect to third-party hosts to shave handshakes." },
  { key: "remove_query_strings", label: "Remove asset query strings", impact: "Drop ?ver= so proxies cache static files better." },
  { key: "disable_emojis", label: "Disable emoji script", impact: "Remove the emoji script WordPress injects on every page." },
  { key: "disable_embeds", label: "Disable oEmbed script", impact: "Remove the embed script if you don't embed WP posts." },
  { key: "instant_page", label: "Instant navigation", impact: "Preload a link the moment a visitor hovers it." },
  { key: "heartbeat_control", label: "Throttle heartbeat", impact: "Slow the admin heartbeat AJAX to cut background load." },
];

export interface SpeedPackControlsProps {
  readonly settings: SpeedPackSettings;
  readonly status: SpeedPackStatus;
  readonly busy: string | null;
  readonly onSave: (next: SpeedPackSettings) => void;
}

export function SpeedPackControls({ settings, status, busy, onSave }: SpeedPackControlsProps): ReactNode {
  return (
    <div className="grid gap-2.5 sm:grid-cols-2">
      {SPEED_PACK_META.map((meta) => (
        <Toggle
          key={meta.key}
          label={meta.label}
          impact={meta.impact}
          risk={meta.risk}
          checked={settings[meta.key] === true}
          disabled={busy !== null}
          onChange={(next) => onSave({ ...settings, [meta.key]: next })}
          note={
            meta.key === "server_headers" && settings.server_headers && !status.htaccess_writable ? (
              <Pill tone="warn">.htaccess not writable — add the Speed Pack block by hand</Pill>
            ) : null
          }
        />
      ))}
    </div>
  );
}

export interface LazyLoadControlsProps {
  readonly settings: LazyLoadSettings;
  readonly busy: string | null;
  readonly onSave: (next: LazyLoadSettings) => void;
}

export function LazyLoadControls({ settings, busy, onSave }: LazyLoadControlsProps): ReactNode {
  const [skip, setSkip] = useState<number>(settings.skip_images);
  return (
    <div className="space-y-2.5">
      <Toggle
        label="Lazy-load images"
        impact="Defer off-screen images so the first screen loads faster."
        checked={settings.enabled}
        disabled={busy !== null}
        onChange={(next) => onSave({ ...settings, enabled: next })}
      />
      <Toggle
        label="Also lazy-load iframes"
        impact="Defer embedded videos and maps until they scroll into view."
        checked={settings.lazy_iframes}
        disabled={busy !== null || !settings.enabled}
        onChange={(next) => onSave({ ...settings, lazy_iframes: next })}
      />
      <label className="flex items-center justify-between gap-3 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-950/40">
        <span className="min-w-0">
          <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Keep first images eager</span>
          <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">
            Leave the top image(s) un-deferred so your largest-content paint stays fast.
          </span>
        </span>
        <input
          type="number"
          min={0}
          max={20}
          value={skip}
          disabled={busy !== null || !settings.enabled}
          onChange={(e) => setSkip(Number(e.target.value))}
          onBlur={() => skip !== settings.skip_images && onSave({ ...settings, skip_images: skip })}
          className={`${INPUT} w-20`}
          aria-label="Number of leading images to keep eager"
        />
      </label>
    </div>
  );
}
