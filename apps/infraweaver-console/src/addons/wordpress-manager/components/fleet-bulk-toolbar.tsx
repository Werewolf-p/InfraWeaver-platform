"use client";

/**
 * Bulk-action toolbar for the WordPress fleet overview. Appears whenever one or
 * more sites are selected and fans a chosen action out across the selection:
 *
 *  - Update plugins   — per-site POST /manage {type:"update-all"} at concurrency 3,
 *                       with live per-site progress.
 *  - Update connector — one POST /connector-update-sweep {sites:[…]}.
 *  - Warm up          — one POST /manage/sweep {sites:[…]} (no confirm; read-only).
 *
 * Destructive-ish actions (plugins / connector) route through a confirm step that
 * lists the target sites; warm-up runs immediately. Results render as a compact
 * per-site ok/failed list. Reuses the accessible `Modal` primitive + button styles
 * from the Manage console so focus handling and the zinc/sky language match.
 */

import { useCallback, useEffect, useRef, useState, type ElementType } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  PackageCheck,
  CircleArrowUp,
  GitBranch,
  RefreshCw,
  Loader2,
  CheckCircle2,
  XCircle,
  CircleDashed,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import { Modal, BTN, BTN_PRIMARY } from "./demo/manage/manage-ui";
import { EASE_OUT } from "./demo/motion";
import { CHANNELS, DEFAULT_CHANNEL, isReleaseChannel, listChannels, type ReleaseChannel } from "../lib/channels";
import { ChannelBadge } from "./channel-badge";

// ── Action model ──────────────────────────────────────────────────────────────

type BulkKind = "update-plugins" | "update-connector" | "warmup" | "assign-channel";

interface BulkActionMeta {
  readonly kind: BulkKind;
  readonly label: string;
  readonly icon: ElementType;
  /** Show a target-listing confirm before running. */
  readonly confirm: boolean;
  readonly title: (count: number) => string;
  readonly description: string;
}

const ACTIONS: ReadonlyArray<BulkActionMeta> = [
  {
    kind: "update-plugins",
    label: "Update plugins",
    icon: PackageCheck,
    confirm: true,
    title: (count) => `Update plugins & themes on ${count} ${count === 1 ? "site" : "sites"}?`,
    description: "Runs the all-plugins-and-themes updater on each selected site, three at a time.",
  },
  {
    kind: "update-connector",
    label: "Update connector",
    icon: CircleArrowUp,
    confirm: true,
    title: (count) => `Update the connector on ${count} ${count === 1 ? "site" : "sites"}?`,
    description: "Reinstalls the bundled InfraWeaver Connector on each selected enrolled site.",
  },
  {
    kind: "warmup",
    label: "Warm up",
    icon: RefreshCw,
    confirm: false,
    title: (count) => `Warming up ${count} ${count === 1 ? "site" : "sites"}`,
    description: "Force-pulls a fresh Manage snapshot for each selected site.",
  },
];

/**
 * The bulk channel-assign action. Kept out of ACTIONS because it needs a channel
 * `<select>` alongside its button rather than a plain icon button. Assigning a
 * channel is pure console bookkeeping (no wire push) — it records which release
 * train each selected site rides; the version lands on the next update sweep.
 */
const CHANNEL_ACTION: BulkActionMeta = {
  kind: "assign-channel",
  label: "Assign channel",
  icon: GitBranch,
  confirm: true,
  title: (count) => `Assign a release channel to ${count} ${count === 1 ? "site" : "sites"}?`,
  description: "Records the chosen release channel on each selected site. Takes effect on the next connector update sweep.",
};

// ── Per-site run state ────────────────────────────────────────────────────────

type RunStatus = "pending" | "running" | "ok" | "error";

interface SiteRun {
  readonly site: string;
  readonly status: RunStatus;
  readonly message?: string;
}

interface DialogState {
  readonly kind: BulkKind;
  readonly targets: readonly string[];
  readonly phase: "confirm" | "running" | "done";
  readonly runs: readonly SiteRun[];
  /** The chosen channel for an `assign-channel` run. */
  readonly channel?: ReleaseChannel;
}

// ── Contracts for the two batched sweep endpoints ─────────────────────────────

interface ConnectorSweepResult {
  readonly site: string;
  readonly ok: boolean;
  readonly version?: string | null;
  /** The release channel this site rides (`channel ?? prod`). */
  readonly channel?: ReleaseChannel;
  /** The version its channel resolves to — what the run aimed to install. */
  readonly target?: string;
  /** Set when the site was already at/ahead of its channel target (no reinstall). */
  readonly skipped?: string;
  readonly reason?: string;
}
interface ConnectorSweepSummary {
  readonly total: number;
  readonly updated: number;
  readonly failed: number;
  readonly results: readonly ConnectorSweepResult[];
}
interface WarmupResult {
  readonly site: string;
  readonly ok: boolean;
}
interface WarmupSummary {
  readonly total: number;
  readonly captured: number;
  readonly failed: number;
  readonly results: readonly WarmupResult[];
}

// ── Endpoint callers ──────────────────────────────────────────────────────────

async function updateAllForSite(site: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`/api/wordpress/sites/${encodeURIComponent(site)}/manage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "update-all" }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
    if (!res.ok) return { ok: false, message: data.error ?? `Request failed (${res.status})` };
    return { ok: data.ok ?? false, message: data.message ?? (data.ok ? "Updated" : "Update failed") };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Network error" };
  }
}

async function setChannelForSite(site: string, channel: ReleaseChannel): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`/api/wordpress/sites/${encodeURIComponent(site)}/iwsl/ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set-channel", channel }),
    });
    const data = (await res.json().catch(() => ({}))) as { channel?: { channel?: ReleaseChannel }; error?: string };
    if (!res.ok) return { ok: false, message: data.error ?? `Request failed (${res.status})` };
    const applied = data.channel?.channel ?? channel;
    return { ok: true, message: `On ${CHANNELS[applied].label}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Network error" };
  }
}

async function postSweep<T>(url: string, sites: readonly string[]): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sites }),
  });
  const data = (await res.json().catch(() => ({}))) as { summary?: T; error?: string };
  if (!res.ok || !data.summary) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data.summary;
}

/** Bounded-concurrency fan-out; `worker` reports its own progress via side effects. */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    }),
  );
}

// ── Presentational bits ───────────────────────────────────────────────────────

const STATUS_ICON: Record<RunStatus, ElementType> = {
  pending: CircleDashed,
  running: Loader2,
  ok: CheckCircle2,
  error: XCircle,
};

function StatusIcon({ status }: { status: RunStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <Icon
      className={cn(
        "h-4 w-4 shrink-0",
        status === "ok" && "text-emerald-500 dark:text-emerald-400",
        status === "error" && "text-red-500 dark:text-red-400",
        status === "running" && "animate-spin text-sky-500 dark:text-sky-400",
        status === "pending" && "text-zinc-400 dark:text-zinc-500",
      )}
      aria-hidden
    />
  );
}

/**
 * One-line verdict for a per-site connector-sweep result, surfacing the new
 * per-site channel/target/skipped fields: "current" when the site was already at
 * its channel target, "behind → <target>" when it was updated, else the failure
 * reason. The channel label is appended so the operator sees which train drove it.
 */
function describeSweepResult(r: ConnectorSweepResult): string {
  const channelSuffix = r.channel ? ` · ${CHANNELS[r.channel].label}` : "";
  if (!r.ok) return r.reason ?? "Update failed";
  if (r.skipped) return `current — already on ${r.version ?? r.target ?? "target"}${channelSuffix}`;
  const landed = r.version ?? r.target;
  return landed ? `behind → updated to ${landed}${channelSuffix}` : `updated${channelSuffix}`;
}

function TargetList({ sites }: { sites: readonly string[] }) {
  return (
    <ul className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-zinc-200 bg-zinc-50 p-2 text-sm dark:border-zinc-800 dark:bg-zinc-950/50">
      {sites.map((site) => (
        <li key={site} className="truncate px-1 font-mono text-xs text-zinc-700 dark:text-zinc-300">
          {site}
        </li>
      ))}
    </ul>
  );
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

interface FleetBulkToolbarProps {
  /** Selected sites in display order (already pruned to existing sites). */
  readonly selectedSites: readonly string[];
  /** Clear the whole selection. */
  readonly onClear: () => void;
  /** Called after a bulk run finishes, so the caller can refetch the fleet. */
  readonly onDone?: () => void;
}

export function FleetBulkToolbar({ selectedSites, onClear, onDone }: FleetBulkToolbarProps) {
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [bulkChannel, setBulkChannel] = useState<ReleaseChannel>(DEFAULT_CHANNEL);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const safeSetDialog = useCallback((update: (prev: DialogState | null) => DialogState | null) => {
    if (mounted.current) setDialog(update);
  }, []);

  const running = dialog?.phase === "running";

  const startRun = useCallback(
    async (kind: BulkKind, targets: readonly string[], channel?: ReleaseChannel) => {
      // update-plugins + assign-channel fan out client-side with per-site progress;
      // the sweep-backed actions run server-side and report once.
      const clientFanOut = kind === "update-plugins" || kind === "assign-channel";
      const initialStatus: RunStatus = clientFanOut ? "pending" : "running";
      safeSetDialog(() => ({
        kind,
        targets,
        phase: "running",
        runs: targets.map((site) => ({ site, status: initialStatus })),
        channel,
      }));

      let finalRuns: SiteRun[];

      if (kind === "update-plugins" || kind === "assign-channel") {
        const chosen = channel ?? DEFAULT_CHANNEL;
        const worker =
          kind === "assign-channel"
            ? (site: string) => setChannelForSite(site, chosen)
            : (site: string) => updateAllForSite(site);
        const outcomes = new Map<string, { ok: boolean; message: string }>();
        await runWithConcurrency(targets, 3, async (site) => {
          safeSetDialog((prev) =>
            prev ? { ...prev, runs: prev.runs.map((r) => (r.site === site ? { ...r, status: "running" } : r)) } : prev,
          );
          const result = await worker(site);
          outcomes.set(site, result);
          safeSetDialog((prev) =>
            prev
              ? {
                  ...prev,
                  runs: prev.runs.map((r) =>
                    r.site === site ? { ...r, status: result.ok ? "ok" : "error", message: result.message } : r,
                  ),
                }
              : prev,
          );
        });
        finalRuns = targets.map((site) => {
          const result = outcomes.get(site);
          return { site, status: result?.ok ? "ok" : "error", message: result?.message };
        });
      } else if (kind === "update-connector") {
        try {
          const summary = await postSweep<ConnectorSweepSummary>("/api/wordpress/connector-update-sweep", targets);
          const results = Array.isArray(summary.results) ? summary.results : [];
          const bySite = new Map(results.map((r) => [r.site, r]));
          finalRuns = targets.map((site) => {
            const result = bySite.get(site);
            if (!result) return { site, status: "error", message: "No result returned" };
            return {
              site,
              status: result.ok ? "ok" : "error",
              message: describeSweepResult(result),
            };
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Sweep failed";
          finalRuns = targets.map((site) => ({ site, status: "error", message }));
        }
      } else {
        try {
          const summary = await postSweep<WarmupSummary>("/api/wordpress/manage/sweep", targets);
          const results = Array.isArray(summary.results) ? summary.results : [];
          const bySite = new Map(results.map((r) => [r.site, r]));
          finalRuns = targets.map((site) => {
            const result = bySite.get(site);
            if (!result) return { site, status: "error", message: "No result returned" };
            return { site, status: result.ok ? "ok" : "error", message: result.ok ? "Snapshot refreshed" : "Warm-up failed" };
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Sweep failed";
          finalRuns = targets.map((site) => ({ site, status: "error", message }));
        }
      }

      const failed = finalRuns.filter((r) => r.status === "error").length;
      const ok = finalRuns.length - failed;
      const noun = (kind === "assign-channel"
        ? CHANNEL_ACTION.label
        : ACTIONS.find((a) => a.kind === kind)?.label ?? "action"
      ).toLowerCase();
      if (failed === 0) {
        toast.success(`${noun}: ${ok}/${finalRuns.length} succeeded`);
      } else if (ok === 0) {
        toast.error(`${noun}: all ${failed} failed`);
      } else {
        toast.warning(`${noun}: ${ok} succeeded, ${failed} failed`);
      }

      safeSetDialog((prev) => (prev ? { ...prev, phase: "done", runs: finalRuns } : prev));
      onDone?.();
    },
    [safeSetDialog, onDone],
  );

  const beginAction = useCallback(
    (meta: BulkActionMeta, channel?: ReleaseChannel) => {
      const targets = [...selectedSites];
      if (targets.length === 0) return;
      if (meta.confirm) {
        setDialog({ kind: meta.kind, targets, phase: "confirm", runs: [], channel });
      } else {
        void startRun(meta.kind, targets, channel);
      }
    },
    [selectedSites, startRun],
  );

  const closeDialog = useCallback(() => {
    if (mounted.current) setDialog(null);
  }, []);

  const activeMeta = dialog
    ? dialog.kind === "assign-channel"
      ? CHANNEL_ACTION
      : ACTIONS.find((a) => a.kind === dialog.kind) ?? null
    : null;
  const doneCount = dialog ? dialog.runs.filter((r) => r.status === "ok" || r.status === "error").length : 0;
  const failedCount = dialog ? dialog.runs.filter((r) => r.status === "error").length : 0;

  return (
    <>
      <AnimatePresence initial={false}>
        {selectedSites.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-sky-500/30 bg-sky-500/5 px-3 py-2.5 dark:bg-sky-500/10"
          >
            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100" aria-live="polite">
              {selectedSites.length} selected
            </span>
            <span className="mx-1 hidden h-4 w-px bg-zinc-300 sm:block dark:bg-zinc-700" aria-hidden />
            <div className="flex flex-wrap items-center gap-2">
              {ACTIONS.map((meta) => {
                const Icon = meta.icon;
                return (
                  <button
                    key={meta.kind}
                    type="button"
                    onClick={() => beginAction(meta)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-colors hover:border-zinc-400 hover:text-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-zinc-600 dark:hover:text-white"
                  >
                    <Icon className="h-4 w-4" aria-hidden />
                    {meta.label}
                  </button>
                );
              })}
              {/* Bulk channel assign — a select + apply, beside the action buttons. */}
              <div className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-1.5 py-1 dark:border-zinc-700 dark:bg-zinc-900">
                <GitBranch className="ml-1 h-4 w-4 text-zinc-500 dark:text-zinc-400" aria-hidden />
                <label htmlFor="bulk-channel" className="sr-only">
                  Release channel to assign
                </label>
                <select
                  id="bulk-channel"
                  value={bulkChannel}
                  onChange={(e) => {
                    if (isReleaseChannel(e.target.value)) setBulkChannel(e.target.value);
                  }}
                  className="rounded-md border border-zinc-300 bg-white px-1.5 py-1 text-sm font-medium text-zinc-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
                >
                  {listChannels().map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => beginAction(CHANNEL_ACTION, bulkChannel)}
                  className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-zinc-700 transition-colors hover:text-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 dark:text-zinc-200 dark:hover:text-white"
                >
                  Assign channel
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={onClear}
              className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-zinc-500 transition-colors hover:text-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              <X className="h-4 w-4" aria-hidden /> Clear
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <Modal
        open={dialog !== null}
        onClose={running ? () => undefined : closeDialog}
        title={dialog && activeMeta ? activeMeta.title(dialog.targets.length) : ""}
        description={activeMeta?.description}
        icon={activeMeta?.icon}
      >
        {dialog && dialog.phase === "confirm" ? (
          <div className="space-y-4">
            {dialog.kind === "assign-channel" && dialog.channel && (
              <p className="flex flex-wrap items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-300">
                Move these {dialog.targets.length} {dialog.targets.length === 1 ? "site" : "sites"} to the
                <ChannelBadge channel={dialog.channel} /> channel.
              </p>
            )}
            <TargetList sites={dialog.targets} />
            <div className="flex justify-end gap-2">
              <button type="button" className={BTN} onClick={closeDialog}>
                Cancel
              </button>
              <button
                type="button"
                className={BTN_PRIMARY}
                onClick={() => void startRun(dialog.kind, dialog.targets, dialog.channel)}
              >
                {activeMeta?.label}
              </button>
            </div>
          </div>
        ) : dialog ? (
          <div className="space-y-4">
            <div role="status" aria-live="polite" className="space-y-1.5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-zinc-700 dark:text-zinc-300">
                  {running
                    ? `Working… ${doneCount}/${dialog.targets.length}`
                    : failedCount === 0
                      ? `Done — all ${dialog.targets.length} succeeded`
                      : `Done — ${dialog.targets.length - failedCount} succeeded, ${failedCount} failed`}
                </span>
                {running ? <Loader2 className="h-4 w-4 animate-spin text-sky-500" aria-hidden /> : null}
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-300",
                    failedCount > 0 && !running ? "bg-amber-500" : "bg-sky-500",
                  )}
                  style={{ width: `${dialog.targets.length === 0 ? 0 : (doneCount / dialog.targets.length) * 100}%` }}
                />
              </div>
            </div>

            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {dialog.runs.map((run) => (
                <li
                  key={run.site}
                  className="flex items-center gap-2 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm dark:border-zinc-800"
                >
                  <StatusIcon status={run.status} />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-700 dark:text-zinc-300">
                    {run.site}
                  </span>
                  {run.message ? (
                    <span
                      className={cn(
                        "shrink-0 truncate text-xs",
                        run.status === "error" ? "text-red-500 dark:text-red-400" : "text-zinc-500 dark:text-zinc-400",
                      )}
                      title={run.message}
                    >
                      {run.message}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>

            {!running ? (
              <div className="flex justify-end">
                <button type="button" className={BTN_PRIMARY} onClick={closeDialog}>
                  Close
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </>
  );
}
