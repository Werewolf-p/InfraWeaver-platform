"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  CircleArrowUp,
  CircleDashed,
  GitBranch,
  Loader2,
  RotateCcw,
  Server,
  XCircle,
} from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import { toast } from "@/lib/notify";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  canPromoteChannel,
  getChannel,
  listChannels,
  resolveChannel,
  type ReleaseChannel,
} from "../lib/channels";
import { ChannelBadge } from "./channel-badge";

/**
 * The release board — the fleet-wide, operator-facing surface for the release
 * channel → Connector-version registry (the "which build does each train point
 * at" map). It is the console sibling of the per-site channel switcher: the site
 * switcher chooses which train a site rides, the board chooses what version each
 * train delivers.
 *
 * Shows, per channel: the pinned version + who/when set it, a promote button
 * (alpha→beta, beta→prod, direction gated by `canPromoteChannel`), a rollback
 * control (pin the channel to an explicit prior version), and the list of sites
 * riding it (derived from the fleet link records + each record's channel). A
 * fleet update sweep can be launched from here; its per-site results surface the
 * channel/target/skipped fields so the operator sees behind/current/skipped at a
 * glance. Promote-to-prod, rollback and the sweep confirm first.
 *
 * All mutations are server-gated on `wordpress:admin` (the same authority the tier
 * controls use); reads need only `wordpress:read`.
 */

interface ChannelEntry {
  version: string;
  updatedAt: string;
  updatedBy: string;
}
type ChannelRegistry = Record<ReleaseChannel, ChannelEntry>;

interface FleetSiteView {
  siteId: string;
  name: string;
  siteName?: string;
  managed?: boolean;
  channel?: ReleaseChannel;
  state: "pending" | "active" | "quarantined";
  connectorVersion?: string;
}

interface SweepResult {
  site: string;
  ok: boolean;
  channel?: ReleaseChannel;
  target?: string;
  version?: string | null;
  skipped?: string;
  reason?: string;
}

interface SweepSummary {
  ranAt: string;
  targetVersion: string;
  total: number;
  updated: number;
  failed: number;
  skipped: number;
  deferred: number;
  results: SweepResult[];
}

async function fetchRegistry(): Promise<ChannelRegistry> {
  const res = await fetch("/api/wordpress/connector-channels");
  if (!res.ok) throw new Error("Failed to load the release board");
  return ((await res.json()) as { registry: ChannelRegistry }).registry;
}

async function fetchFleet(): Promise<FleetSiteView[]> {
  const res = await fetch("/api/wordpress/external-sites");
  if (!res.ok) throw new Error("Failed to load the site fleet");
  return ((await res.json()) as { sites?: FleetSiteView[] }).sites ?? [];
}

/** A pending action awaiting the shared confirm dialog. */
type PendingConfirm =
  | { kind: "promote"; from: ReleaseChannel; to: ReleaseChannel }
  | { kind: "rollback"; channel: ReleaseChannel; version: string }
  | { kind: "sweep" };

/** Label a site by its provisioned name (managed) or its external display name. */
function siteLabel(site: FleetSiteView): string {
  return site.siteName ?? site.name;
}

/** The behind/current/skipped/failed verdict for one sweep result row. */
function resultState(r: SweepResult): { label: string; tone: string; Icon: typeof CheckCircle2 } {
  if (!r.ok) return { label: r.reason ?? "failed", tone: "text-red-300", Icon: XCircle };
  if (r.skipped) return { label: "current", tone: "text-emerald-300", Icon: CheckCircle2 };
  return { label: "was behind — updated", tone: "text-sky-300", Icon: CircleArrowUp };
}

export function ReleaseBoard() {
  const queryClient = useQueryClient();
  const [rollbackDrafts, setRollbackDrafts] = useState<Partial<Record<ReleaseChannel, string>>>({});
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const { data: registry, isLoading: registryLoading, isError: registryError } = useQuery({
    queryKey: ["wordpress-connector-channels"],
    queryFn: fetchRegistry,
  });

  const { data: fleet = [] } = useQuery({
    queryKey: ["wordpress-external-sites"],
    queryFn: fetchFleet,
    refetchInterval: 10000,
  });

  const invalidateBoard = () => {
    void queryClient.invalidateQueries({ queryKey: ["wordpress-connector-channels"] });
    void queryClient.invalidateQueries({ queryKey: ["wordpress-external-sites"] });
  };

  const promoteMutation = useMutation({
    mutationFn: async ({ from, to }: { from: ReleaseChannel; to: ReleaseChannel }) => {
      const res = await fetch("/api/wordpress/connector-channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "promote", from, to }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Promotion failed");
      return ((await res.json()) as { registry: ChannelRegistry }).registry;
    },
    onSuccess: (next, { from, to }) => {
      toast.success(`Promoted ${getChannel(from).label} → ${getChannel(to).label} (${next[to].version})`);
      invalidateBoard();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const rollbackMutation = useMutation({
    mutationFn: async ({ channel, version }: { channel: ReleaseChannel; version: string }) => {
      const res = await fetch("/api/wordpress/connector-channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rollback", channel, version }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Rollback failed");
      return ((await res.json()) as { registry: ChannelRegistry }).registry;
    },
    onSuccess: (_next, { channel, version }) => {
      toast.success(`${getChannel(channel).label} pinned to ${version}`);
      setRollbackDrafts((prev) => ({ ...prev, [channel]: "" }));
      invalidateBoard();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const sweepMutation = useMutation({
    mutationFn: async (): Promise<SweepSummary> => {
      const res = await fetch("/api/wordpress/connector-update-sweep", { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Update sweep failed");
      return ((await res.json()) as { summary: SweepSummary }).summary;
    },
    onSuccess: (summary) => {
      const deferredTail = summary.deferred > 0 ? ` — ${summary.deferred} deferred, run again to continue` : "";
      if (summary.total === 0) {
        toast.success("No enrolled connectors to update");
      } else if (summary.failed === 0) {
        toast.success(
          `Sweep done — ${summary.updated} updated, ${summary.skipped} already current${deferredTail}`,
        );
      } else {
        toast.warning(
          `Sweep done — ${summary.updated} updated, ${summary.skipped} current, ${summary.failed} failed${deferredTail}`,
        );
      }
      invalidateBoard();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const mutating = promoteMutation.isPending || rollbackMutation.isPending;
  const sweep = sweepMutation.data;

  const confirmPending = () => {
    if (!pending) return;
    if (pending.kind === "promote") promoteMutation.mutate({ from: pending.from, to: pending.to });
    else if (pending.kind === "rollback") rollbackMutation.mutate({ channel: pending.channel, version: pending.version });
    else sweepMutation.mutate();
    setPending(null);
  };

  // The confirm dialog copy for whichever action is armed.
  const confirmCopy: { title: string; description: string; confirmText: string; danger: boolean } | null = pending
    ? pending.kind === "promote"
      ? {
          title: `Promote ${getChannel(pending.from).label} → ${getChannel(pending.to).label}?`,
          description:
            pending.to === "prod"
              ? "This points the production train at the beta build. Every prod site picks it up on the next update sweep."
              : `This points ${getChannel(pending.to).label} at the current ${getChannel(pending.from).label} build.`,
          confirmText: "Promote",
          danger: pending.to === "prod",
        }
      : pending.kind === "rollback"
        ? {
            title: `Pin ${getChannel(pending.channel).label} to ${pending.version}?`,
            description:
              "This overrides the channel's current version. Sites on this channel move to it on the next update sweep.",
            confirmText: "Roll back",
            danger: true,
          }
        : {
            title: "Run the fleet update sweep?",
            description:
              "Reinstalls each enrolled site's channel-target Connector version in place. Sites already at their target are skipped; keys and link state are untouched.",
            confirmText: "Run sweep",
            danger: false,
          }
    : null;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-zinc-200">
            <GitBranch className="h-5 w-5 text-violet-300" aria-hidden />
            <h2 className="text-lg font-medium">Release board</h2>
          </div>
          <button
            type="button"
            disabled={sweepMutation.isPending}
            onClick={() => setPending({ kind: "sweep" })}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sweepMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <CircleArrowUp className="h-4 w-4" aria-hidden />
            )}
            {sweepMutation.isPending ? "Sweeping…" : "Run update sweep"}
          </button>
        </div>
        <p className="mt-1 max-w-prose text-sm text-zinc-400">
          Each channel points at one Connector version. Promote moves a tested build one rung toward production
          (alpha → beta → prod); rollback pins a channel to an explicit prior version. Sites pick up their channel&rsquo;s
          version on the next update sweep.
        </p>

        {registryLoading ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading the release board…
          </div>
        ) : registryError || !registry ? (
          <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-300">
            The release board couldn&rsquo;t be read right now — retry in a moment.
          </div>
        ) : (
          <ul className="mt-4 space-y-3">
            {listChannels().map((channel) => {
              const entry = registry[channel.id];
              const target = listChannels().find((c) => c.rank === channel.rank - 1);
              const canPromote = target ? canPromoteChannel(channel.id, target.id) : false;
              const sitesOnChannel = fleet.filter((s) => resolveChannel(s) === channel.id);
              const draft = rollbackDrafts[channel.id] ?? "";
              return (
                <li key={channel.id} className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <ChannelBadge channel={channel.id} />
                        <span className="font-mono text-sm text-zinc-100">{entry.version}</span>
                      </div>
                      <p className="mt-1 text-xs text-zinc-500">
                        {entry.updatedAt
                          ? `set ${timeAgo(entry.updatedAt)}${entry.updatedBy ? ` by ${entry.updatedBy}` : ""}`
                          : "seeded from the bundled Connector (never changed)"}
                      </p>
                    </div>
                    {canPromote && target && (
                      <button
                        type="button"
                        disabled={mutating}
                        onClick={() => setPending({ kind: "promote", from: channel.id, to: target.id })}
                        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-violet-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <CircleArrowUp className="h-4 w-4" aria-hidden />
                        Promote to {target.label}
                      </button>
                    )}
                  </div>

                  {/* Sites riding this channel */}
                  <div className="mt-3">
                    <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500">
                      <Server className="h-3.5 w-3.5" aria-hidden /> {sitesOnChannel.length}{" "}
                      {sitesOnChannel.length === 1 ? "site" : "sites"} on this channel
                    </p>
                    {sitesOnChannel.length > 0 ? (
                      <ul className="mt-2 flex flex-wrap gap-1.5">
                        {sitesOnChannel.map((s) => (
                          <li
                            key={s.siteId}
                            className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-900 px-2.5 py-0.5 text-xs text-zinc-200"
                            title={s.connectorVersion ? `running ${s.connectorVersion}` : "version unknown"}
                          >
                            {s.state === "active" ? (
                              <CheckCircle2 className="h-3 w-3 text-emerald-400" aria-hidden />
                            ) : (
                              <CircleDashed className="h-3 w-3 text-zinc-500" aria-hidden />
                            )}
                            <span className="truncate">{siteLabel(s)}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1 text-xs text-zinc-600">No sites ride this channel yet.</p>
                    )}
                  </div>

                  {/* Rollback / pin to an explicit prior version */}
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
                    <label htmlFor={`rollback-${channel.id}`} className="text-xs text-zinc-400">
                      Roll back to
                    </label>
                    <input
                      id={`rollback-${channel.id}`}
                      value={draft}
                      onChange={(e) => setRollbackDrafts((prev) => ({ ...prev, [channel.id]: e.target.value }))}
                      placeholder="e.g. 0.13.0"
                      className="w-32 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500 focus:outline-none"
                    />
                    <button
                      type="button"
                      disabled={mutating || draft.trim() === "" || draft.trim() === entry.version}
                      title={draft.trim() === entry.version ? "Already on this version" : undefined}
                      onClick={() => setPending({ kind: "rollback", channel: channel.id, version: draft.trim() })}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 transition-colors hover:border-amber-500/50 hover:text-amber-200 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <RotateCcw className="h-4 w-4" aria-hidden />
                      Roll back
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Update-sweep results — per-site current version vs channel target */}
      {sweep && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
          <div className="flex items-center gap-2 text-zinc-200">
            <CircleArrowUp className="h-5 w-5 text-sky-400" aria-hidden />
            <h2 className="text-lg font-medium">Last update sweep</h2>
          </div>
          <p className="mt-1 text-sm text-zinc-400">
            {sweep.total} attempted · {sweep.updated} updated · {sweep.skipped} already current · {sweep.failed} failed
            {sweep.deferred > 0 ? ` · ${sweep.deferred} deferred` : ""} — ran {timeAgo(sweep.ranAt)}.
          </p>
          {sweep.results.length > 0 ? (
            <ul className="mt-4 space-y-1.5">
              {sweep.results.map((r) => {
                const { label, tone, Icon } = resultState(r);
                return (
                  <li
                    key={r.site}
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-1.5 text-sm"
                  >
                    <Icon className={cn("h-4 w-4 shrink-0", tone)} aria-hidden />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200">{r.site}</span>
                    {r.channel && <ChannelBadge channel={r.channel} hideIcon />}
                    <span className="shrink-0 font-mono text-xs text-zinc-500">
                      {r.version ?? "—"}
                      {r.target ? ` → ${r.target}` : ""}
                    </span>
                    <span className={cn("shrink-0 text-xs", tone)}>{label}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-zinc-500">No enrolled sites were in range for this sweep.</p>
          )}
        </section>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={confirmCopy?.title ?? ""}
        description={confirmCopy?.description ?? ""}
        confirmText={confirmCopy?.confirmText ?? "Confirm"}
        danger={confirmCopy?.danger ?? false}
        onConfirm={confirmPending}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
