"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Ban,
  Bug,
  Check,
  CheckCircle2,
  CircleArrowUp,
  CircleDashed,
  Fingerprint,
  GitBranch,
  KeyRound,
  Link2,
  Loader2,
  Minus,
  RefreshCw,
  ShieldAlert,
  ShieldBan,
  ShieldCheck,
  Sparkles,
  Unlink,
  XCircle,
} from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import { toast } from "@/lib/notify";
import { isConnectorOutdated } from "../lib/connector-version";
import { ENTITLEMENT_FLAGS, ENTITLEMENT_FLAG_META, type EntitlementMap } from "../lib/entitlements";
import {
  DEFAULT_TIER_ID,
  TIERS,
  isTierId,
  listTiers,
  resolveEntitlements,
  resolveTierId,
  type TierId,
} from "../lib/tiers";
import {
  CHANNELS,
  DEFAULT_CHANNEL,
  isReleaseChannel,
  listChannels,
  resolveChannel,
  type ReleaseChannel,
} from "../lib/channels";
import { ChannelBadge } from "./channel-badge";
import { SiteTabs } from "./site-tabs";

/** Slice of ExternalSiteView the connector tab renders (§5.1 managed link). */
interface ManagedLink {
  siteId: string;
  state: "pending" | "active" | "quarantined";
  fingerprintConfirmed: boolean;
  activatedAt?: string;
  wpFingerprint: string | null;
  iwFingerprint: string;
  kid: number;
  epochFloor: number;
  iwKid: number;
  rejections: number;
  lastSeq?: number;
  lastVerify?: { at: string; ok: boolean; reason?: string };
  lastHealth?: { at: string; ok: boolean; roundtripMs?: number; reason?: string };
  /** Running plugin version from the last verified health.check (§5.1 update signal). */
  connectorVersion?: string;
  pendingRotation?: { newKid: number; phase: string } | null;
  /** §8 — last signing-key reroll outcome (from rotation run or plugin's signed report). */
  lastReroll?: { at: string; outcome: "confirmed" | "aborted" | "pending"; kid: number; reason?: string };
  /** §8 — per-site auto-rotation schedule override (absent ⇒ fleet default). */
  rotationPolicy?: { autoRotate: boolean; intervalMs?: number; updatedAt?: string; updatedBy?: string };
  /** Paid-feature entitlements mirrored from the last signed push (absent ⇒ none). */
  entitlements?: { flags?: EntitlementMap; updatedAt?: string; updatedBy?: string };
  /** Console-authoritative payment tier (absent ⇒ Free). Derives the flag map above. */
  tier?: TierId;
  /** Console-authoritative release channel (absent ⇒ prod). Steers which Connector version the update sweep targets. */
  channel?: ReleaseChannel;
  /** §5 identity binding — the site's confirmed canonical URL. */
  canonicalUrl?: string;
  /** §5 safe mode: state-changing ops suspended after a self-reported URL change. */
  identitySuspended?: boolean;
  identityAlert?: {
    reason: "url-changed" | "stopped-reporting";
    observedUrl: string;
    boundUrl: string;
    at: string;
  };
}

interface ManagedLinkResponse {
  link: ManagedLink | null;
  /** Connector version bundled in the console image; null when unreadable. */
  bundledConnectorVersion: string | null;
}

interface HealthResult {
  ok: boolean;
  roundtripMs: number;
  result: Record<string, unknown>;
  rejectedReason?: string;
}

interface DebugResult {
  statusText: string;
  selftestText: string;
  debug: Record<string, unknown> | null;
  debugUnavailable?: string;
}

interface RotationResult {
  outcome: "confirmed" | "aborted" | "pending";
  kid: number;
  wpFingerprint: string | null;
}

async function fetchManagedLink(site: string): Promise<ManagedLinkResponse> {
  const res = await fetch(`/api/wordpress/sites/${site}/iwsl`);
  if (!res.ok) throw new Error("Failed to load connector link state");
  const body = (await res.json()) as { link?: ManagedLink | null; bundledConnectorVersion?: string | null };
  return { link: body.link ?? null, bundledConnectorVersion: body.bundledConnectorVersion ?? null };
}

async function postOp<T>(site: string, action: string, extra?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/api/wordpress/sites/${site}/iwsl/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Operation failed");
  return res.json() as Promise<T>;
}

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/** Split a stored interval (ms) into the friendliest whole {value, unit} for editing. */
function intervalToParts(intervalMs: number | undefined, fallbackDays: number): { value: number; unit: "hours" | "days" } {
  const ms = typeof intervalMs === "number" && intervalMs > 0 ? intervalMs : fallbackDays * MS_PER_DAY;
  if (ms % MS_PER_DAY === 0) return { value: ms / MS_PER_DAY, unit: "days" };
  return { value: Math.max(1, Math.round(ms / MS_PER_HOUR)), unit: "hours" };
}

function StateBadge({ link, loadError }: { link: ManagedLink | null; loadError?: boolean }) {
  // A failed status read is not the same as an unlinked site — don't assert
  // "Not linked" when we simply couldn't reach the status endpoint.
  if (loadError) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/15 px-2.5 py-0.5 text-xs text-amber-300">
        <AlertTriangle className="h-3 w-3" aria-hidden /> Status unavailable
      </span>
    );
  }
  if (!link) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-950/50 px-2.5 py-0.5 text-xs text-zinc-400">
        Not linked
      </span>
    );
  }
  if (link.state === "quarantined") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/15 px-2.5 py-0.5 text-xs text-red-300">
        <ShieldBan className="h-3 w-3" aria-hidden /> Quarantined
      </span>
    );
  }
  if (link.state === "active" && link.fingerprintConfirmed) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-green-500/30 bg-green-500/15 px-2.5 py-0.5 text-xs text-green-300">
        <CheckCircle2 className="h-3 w-3" aria-hidden /> Linked
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/15 px-2.5 py-0.5 text-xs text-sky-300">
      <CircleDashed className="h-3 w-3 animate-pulse" aria-hidden /> Pending
    </span>
  );
}

/**
 * The site's current payment tier as a pill. Paid tiers read in the brand amber
 * (the same accent as the Plus/entitlement surface); the Free base reads as a
 * quiet neutral so an unentitled site doesn't shout.
 */
function TierBadge({ tierId }: { tierId: TierId }) {
  const tier = TIERS[tierId];
  const isPaid = tier.rank > 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        isPaid ? "border-amber-400/30 bg-amber-400/15 text-amber-200" : "border-zinc-700 bg-zinc-950/50 text-zinc-400",
      )}
    >
      {isPaid && <Sparkles className="h-3 w-3" aria-hidden />}
      {tier.displayName}
    </span>
  );
}

function MetaRow({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-zinc-500">{label}</span>
      <span className={cn("truncate text-right font-mono", tone === "danger" ? "text-red-300" : "text-zinc-300")}>
        {value}
      </span>
    </div>
  );
}

/** A health result older than this is flagged stale — the hourly sweep is overdue. */
const HEALTH_STALE_MS = 90 * 60 * 1000;

function isHealthStale(at: string): boolean {
  return Date.now() - new Date(at).getTime() > HEALTH_STALE_MS;
}

/**
 * §12.5 last-health row: a ✓/✗ glyph for the pass/fail verdict, a relative
 * "checked" time, and a stale warning when the last check is over 90 min old.
 * A stale-but-passing result reads as a warning, not as healthy.
 */
function HealthRow({ lastHealth }: { lastHealth?: ManagedLink["lastHealth"] }) {
  if (!lastHealth) {
    return (
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="shrink-0 text-zinc-500">Last health check</span>
        <span className="inline-flex items-center gap-1.5 font-mono text-zinc-500">
          <CircleDashed className="h-3.5 w-3.5 shrink-0" aria-hidden /> never checked
        </span>
      </div>
    );
  }
  const stale = isHealthStale(lastHealth.at);
  const { ok } = lastHealth;
  const Icon = ok ? CheckCircle2 : XCircle;
  const color = !ok ? "text-red-300" : stale ? "text-amber-300" : "text-emerald-300";
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="shrink-0 text-zinc-500">Last health check</span>
      <span className={cn("inline-flex items-center gap-1.5 font-mono", color)}>
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {ok ? "pass" : `fail (${lastHealth.reason ?? "unknown"})`}
        <span className="text-zinc-600">·</span>
        <span className="text-zinc-400">{timeAgo(lastHealth.at)}</span>
        {stale && (
          <span className="inline-flex items-center gap-1 text-amber-400">
            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden /> stale
          </span>
        )}
      </span>
    </div>
  );
}

const ROTATION_TOAST: Record<RotationResult["outcome"], string> = {
  confirmed: "Signing key rerolled — the new key is live",
  pending: "Rotation started but not confirmed yet — run it again to resume",
  aborted: "Rotation aborted — the previous key stays active",
};

export function ConnectorView({ site }: { site: string }) {
  const queryClient = useQueryClient();
  const [killArmed, setKillArmed] = useState(false);
  const [revokeArmed, setRevokeArmed] = useState(false);
  // Tier selector (seeded from the link's authoritative tier below).
  const [selectedTier, setSelectedTier] = useState<TierId>(DEFAULT_TIER_ID);
  const tierSeededKey = useRef<string>("");
  // Release-channel selector (seeded from the link's authoritative channel below).
  const [selectedChannel, setSelectedChannel] = useState<ReleaseChannel>(DEFAULT_CHANNEL);
  const channelSeededKey = useRef<string>("");
  // Auto-rotation schedule form (seeded from the link's saved policy below).
  const [rotAuto, setRotAuto] = useState(true);
  const [rotValue, setRotValue] = useState(30);
  const [rotUnit, setRotUnit] = useState<"hours" | "days">("days");
  const rotSeededKey = useRef<string>("");

  const { data: linkData, isLoading: linkLoading, isError: linkError } = useQuery({
    queryKey: ["wordpress-iwsl-link", site],
    queryFn: () => fetchManagedLink(site),
  });
  const link = linkData?.link ?? null;
  // A failed fetch with no cached link must NOT be read as "not linked": that
  // renders an Enable-connector CTA and invites a needless re-enroll of a site
  // that is almost certainly still linked. Show a distinct, retryable load error.
  const linkLoadFailed = linkError && !link;
  const bundledConnectorVersion = linkData?.bundledConnectorVersion ?? null;

  const refetchLink = () => void queryClient.invalidateQueries({ queryKey: ["wordpress-iwsl-link", site] });

  // Seed the schedule form from the saved policy once per site + policy version,
  // so ordinary link refetches (health, version, etc.) don't clobber an in-flight edit.
  useEffect(() => {
    if (!link) return;
    const key = `${link.siteId}:${link.rotationPolicy?.updatedAt ?? ""}`;
    if (rotSeededKey.current === key) return;
    rotSeededKey.current = key;
    setRotAuto(link.rotationPolicy?.autoRotate ?? true);
    const parts = intervalToParts(link.rotationPolicy?.intervalMs, 30);
    setRotValue(parts.value);
    setRotUnit(parts.unit);
  }, [link]);

  // Seed the tier selector from the link's authoritative tier, re-seeding only
  // when the applied tier actually changes (keyed on tier + last-push time) so a
  // routine refetch doesn't discard an in-flight selection the operator is eyeing.
  useEffect(() => {
    if (!link) return;
    const current = resolveTierId(link);
    const key = `${link.siteId}:${current}:${link.entitlements?.updatedAt ?? ""}`;
    if (tierSeededKey.current === key) return;
    tierSeededKey.current = key;
    setSelectedTier(current);
  }, [link]);

  // Seed the channel selector from the link's authoritative channel, re-seeding
  // only when the stored channel actually changes so a routine refetch doesn't
  // discard an in-flight selection the operator is eyeing (mirrors the tier seed).
  useEffect(() => {
    if (!link) return;
    const current = resolveChannel(link);
    const key = `${link.siteId}:${current}`;
    if (channelSeededKey.current === key) return;
    channelSeededKey.current = key;
    setSelectedChannel(current);
  }, [link]);

  const enrollMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/wordpress/sites/${site}/iwsl`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Enrollment failed");
    },
    onSuccess: () => {
      toast.success("Connector installed and enrolled — the site is linked");
      refetchLink();
      void queryClient.invalidateQueries({ queryKey: ["wordpress-plugins", site] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const unlinkMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/wordpress/sites/${site}/iwsl`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Unlink failed");
    },
    onSuccess: () => {
      toast.success("Connector link removed");
      refetchLink();
      void queryClient.invalidateQueries({ queryKey: ["wordpress-plugins", site] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const healthMutation = useMutation({
    mutationFn: () => postOp<{ health: HealthResult }>(site, "health"),
    onSuccess: ({ health }) => {
      if (health.ok) toast.success(`Signed health check passed in ${health.roundtripMs} ms`);
      else toast.error(`Health check rejected: ${health.rejectedReason ?? "unknown"}`);
      refetchLink();
    },
    onError: (error: Error) => {
      toast.error(error.message);
      refetchLink();
    },
  });

  const debugMutation = useMutation({
    mutationFn: () => postOp<{ debug: DebugResult }>(site, "debug"),
    onError: (error: Error) => toast.error(error.message),
  });

  const rotateMutation = useMutation({
    mutationFn: () => postOp<{ rotation: RotationResult }>(site, "rotate"),
    onSuccess: ({ rotation }) => {
      const notify = rotation.outcome === "confirmed" ? toast.success : toast.error;
      notify(ROTATION_TOAST[rotation.outcome]);
      refetchLink();
    },
    onError: (error: Error) => {
      toast.error(error.message);
      refetchLink();
    },
  });

  const policyMutation = useMutation({
    mutationFn: (payload: { autoRotate: boolean; intervalMs?: number }) =>
      postOp<{ rotationPolicy: { autoRotate: boolean; intervalMs?: number } }>(site, "set-rotation-policy", {
        rotationPolicy: payload,
      }),
    onSuccess: ({ rotationPolicy }) => {
      toast.success(
        rotationPolicy.autoRotate
          ? "Auto-rotation schedule saved"
          : "Auto-rotation disabled — manual reroll still available",
      );
      refetchLink();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const tierMutation = useMutation({
    // Assign a payment tier. The API route derives the tier's flag map and pushes
    // it to the plugin over the signed command channel; the site can never grant
    // itself a tier. Revoke is the same op with the Free tier (see revokeMutation).
    mutationFn: (tierId: TierId) =>
      postOp<{ entitlements: { tier?: TierId; flags?: EntitlementMap } }>(site, "set-tier", { tier: tierId }),
    onSuccess: ({ entitlements }) => {
      const tid = entitlements.tier ?? DEFAULT_TIER_ID;
      toast.success(`Tier set to ${TIERS[tid].displayName} — pushed to the site over the signed channel`);
      refetchLink();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const channelMutation = useMutation({
    // Assign a release channel. Pure console bookkeeping — unlike the tier, this
    // pushes NOTHING to the plugin at assign time; it only records which release
    // train the site rides. The version it resolves to lands on the plugin later,
    // through the operator-initiated, signed update sweep. A site can never move
    // itself onto a less-stable train.
    mutationFn: (channelId: ReleaseChannel) =>
      postOp<{ channel: { channel: ReleaseChannel; updatedAt: string; updatedBy: string } }>(site, "set-channel", {
        channel: channelId,
      }),
    onSuccess: ({ channel }) => {
      toast.success(`Release channel set to ${CHANNELS[channel.channel].label} — applied on the next update sweep`);
      refetchLink();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const revokeMutation = useMutation({
    // Revoke = assign the Free tier, whose flag map has every paid flag explicitly
    // off, so the plugin's wholesale replace clears the site over the signed channel.
    mutationFn: () =>
      postOp<{ entitlements: { tier?: TierId } }>(site, "set-tier", { tier: DEFAULT_TIER_ID }),
    onSuccess: () => {
      toast.success("Entitlements revoked — the site is back on Free over the signed channel");
      setRevokeArmed(false);
      refetchLink();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const quarantineMutation = useMutation({
    mutationFn: (release: boolean) => postOp<{ ok: true }>(site, release ? "release" : "quarantine"),
    onSuccess: (_data, release) => {
      toast.success(release ? "Link released — commands are allowed again" : "Link quarantined — commands are blocked");
      refetchLink();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const killMutation = useMutation({
    mutationFn: () => postOp<{ wiped: boolean }>(site, "deactivate"),
    onSuccess: ({ wiped }) => {
      toast.success(wiped ? "Kill switch fired — plugin wiped its keys, link destroyed" : "Link destroyed (plugin wipe skipped)");
      setKillArmed(false);
      refetchLink();
      void queryClient.invalidateQueries({ queryKey: ["wordpress-plugins", site] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const updateMutation = useMutation({
    mutationFn: () => postOp<{ version: string | null }>(site, "update-plugin"),
    onSuccess: ({ version }) => {
      toast.success(version ? `Connector updated — running ${version}` : "Connector updated in place");
      void queryClient.invalidateQueries({ queryKey: ["wordpress-plugins", site] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const confirmIdentityMutation = useMutation({
    // Send the exact alert timestamp the operator is looking at so the server
    // binds THIS alert, not one a concurrent sweep may have superseded it with.
    mutationFn: async (expectedIdentityAt: string) => {
      const res = await fetch(`/api/wordpress/sites/${site}/iwsl/ops`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm-identity", expectedIdentityAt }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to confirm identity");
      return res.json() as Promise<{ canonicalUrl?: string }>;
    },
    onSuccess: ({ canonicalUrl }) => {
      toast.success(canonicalUrl ? `Identity re-confirmed — bound to ${canonicalUrl}` : "Identity re-confirmed");
      refetchLink();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const linked = Boolean(link);
  const commandable = link?.state === "active" && link.fingerprintConfirmed;
  // Authoritative tier + flag map, resolved from the CONSOLE record only — never
  // from anything the site self-reports. This is what the panel gates its display on.
  const currentTierId = resolveTierId(link ?? undefined);
  const currentTier = TIERS[currentTierId];
  const grantedFlags = resolveEntitlements(link ?? undefined);
  const tierDirty = selectedTier !== currentTierId;
  const isFreeTier = currentTierId === DEFAULT_TIER_ID;
  const entitlementsBusy = tierMutation.isPending || revokeMutation.isPending;
  // Authoritative release channel, resolved from the console record only.
  const currentChannel = resolveChannel(link ?? undefined);
  const channelDirty = selectedChannel !== currentChannel;
  // §5 safe mode: the site self-reported a changed canonical URL. Read-only
  // health/debug stay available; key rotation and plugin update are blocked.
  const identitySuspended = link?.identitySuspended === true;
  const updateAvailable = isConnectorOutdated(link?.connectorVersion, bundledConnectorVersion);
  const health = healthMutation.data?.health;
  const debug = debugMutation.data?.debug;

  // Belt-and-suspenders: the hourly sweep is the reliable driver, but if an
  // operator lands here on a link whose last check is missing or stale, kick a
  // single refresh so the page shows a current verdict. The ref guards against
  // re-triggering when the mutation's refetch swaps `link` back in.
  const autoCheckedRef = useRef(false);
  const runHealth = healthMutation.mutate;
  useEffect(() => {
    if (autoCheckedRef.current) return;
    if (!link || link.state !== "active" || !link.fingerprintConfirmed) return;
    const stale = !link.lastHealth || isHealthStale(link.lastHealth.at);
    if (!stale) return;
    autoCheckedRef.current = true;
    runHealth();
  }, [link, runHealth]);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <Link href="/wordpress" className="inline-flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-200">
        <ArrowLeft className="h-4 w-4" aria-hidden /> All sites
      </Link>

      <header className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">{site}</h1>
        <StateBadge link={link ?? null} loadError={linkLoadFailed} />
      </header>

      <SiteTabs site={site} active="connector" />

      {/* §5 clone/identity-crisis — safe-mode banner */}
      {identitySuspended && link?.identityAlert && (
        <section className="mt-6 rounded-xl border border-amber-500/40 bg-amber-500/10 p-5">
          <div className="flex items-center gap-2 text-amber-200">
            <ShieldAlert className="h-5 w-5" aria-hidden />
            <h2 className="text-lg font-medium">Identity changed — safe mode</h2>
          </div>
          <p className="mt-1 max-w-prose text-sm text-amber-100/80">
            {link.identityAlert.reason === "stopped-reporting"
              ? "This site stopped reporting its canonical URL, after previously reporting one. It still holds valid signing keys — this can be a plugin downgrade, or an attempt to slip past the identity check. Key rotation and plugin updates are suspended until you confirm."
              : "This site now reports a different canonical URL than the one it was linked under. It still holds valid signing keys, so this is either a legitimate migration or a clone of the site’s database. Key rotation and plugin updates are suspended until you confirm."}
          </p>
          <p className="mt-1 text-xs text-amber-100/60">
            Note: the reported URL is best-effort — a deliberate clone can spoof it. Trust the key fingerprint below over the URL.
          </p>
          <div className="mt-3 grid gap-1.5 rounded-lg border border-amber-500/20 bg-zinc-950/40 p-3 font-mono text-xs">
            <div className="flex items-baseline justify-between gap-3">
              <span className="shrink-0 text-zinc-500">Linked as</span>
              <span className="truncate text-right text-zinc-300">{link.identityAlert.boundUrl}</span>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="shrink-0 text-zinc-500">Now reports</span>
              <span className="truncate text-right text-amber-300">
                {link.identityAlert.reason === "stopped-reporting" ? "(no URL reported)" : link.identityAlert.observedUrl}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="shrink-0 text-zinc-500">Detected</span>
              <span className="text-right text-zinc-400">{timeAgo(link.identityAlert.at)}</span>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
            <span className="mr-auto text-xs text-amber-100/70">
              If you didn&rsquo;t expect this, quarantine or deactivate the link below instead of confirming.
            </span>
            <button
              type="button"
              disabled={confirmIdentityMutation.isPending}
              onClick={() => confirmIdentityMutation.mutate(link.identityAlert!.at)}
              className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-3.5 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {confirmIdentityMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ShieldCheck className="h-4 w-4" aria-hidden />}
              Confirm new identity
            </button>
          </div>
        </section>
      )}

      {/* Link state — the §12.5 status panel for this managed link */}
      <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <div className="flex items-center gap-2 text-zinc-200">
          <Link2 className="h-5 w-5 text-sky-400" aria-hidden />
          <h2 className="text-lg font-medium">Link</h2>
        </div>
        <p className="mt-1 max-w-prose text-sm text-zinc-400">
          The InfraWeaver Connector plugin links this site over the signed IWSL protocol — every command is
          Ed25519 + SLH-DSA signed, every response is verified against the pinned site key.
        </p>

        {linkLoading ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading link state…
          </div>
        ) : link ? (
          <>
            <div className="mt-4 grid gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
              <MetaRow label="IW key fingerprint" value={link.iwFingerprint} />
              <MetaRow label="Site key fingerprint" value={link.wpFingerprint ?? "—"} />
              <MetaRow label="Key epoch (kid / floor)" value={`${link.kid} / ${link.epochFloor}`} />
              <MetaRow label="Command seq" value={`${link.lastSeq ?? 0}`} />
              {link.activatedAt && <MetaRow label="Linked since" value={new Date(link.activatedAt).toLocaleString()} />}
              {link.canonicalUrl && (
                <MetaRow label="Site identity (URL)" value={link.canonicalUrl} tone={identitySuspended ? "danger" : undefined} />
              )}
              {(commandable || link.lastHealth) && <HealthRow lastHealth={link.lastHealth} />}
              {link.connectorVersion && (
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="shrink-0 text-zinc-500">Plugin version</span>
                  <span className="inline-flex items-center gap-1.5 font-mono text-zinc-300">
                    {link.connectorVersion}
                    {updateAvailable && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 font-sans text-[11px] text-amber-300">
                        <CircleArrowUp className="h-3 w-3" aria-hidden /> update available
                      </span>
                    )}
                  </span>
                </div>
              )}
              {link.lastVerify && !link.lastVerify.ok && (
                <MetaRow label="Last verify" value={link.lastVerify.reason ?? "failed"} tone="danger" />
              )}
              {link.rejections > 0 && <MetaRow label="Rejections seen" value={`${link.rejections}`} tone="danger" />}
              {link.pendingRotation && (
                <MetaRow label="Rotation in flight" value={`kid ${link.pendingRotation.newKid} (${link.pendingRotation.phase})`} />
              )}
              {link.lastReroll && (
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="shrink-0 text-zinc-500">Last reroll</span>
                  <span className="inline-flex items-center gap-1.5 truncate text-right font-mono">
                    {link.lastReroll.outcome === "confirmed" ? (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-label="success" />
                    ) : link.lastReroll.outcome === "aborted" ? (
                      <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" aria-label="failed" />
                    ) : (
                      <CircleDashed className="h-3.5 w-3.5 shrink-0 animate-spin text-amber-400" aria-label="in progress" />
                    )}
                    <span
                      className={cn(
                        link.lastReroll.outcome === "confirmed"
                          ? "text-emerald-300"
                          : link.lastReroll.outcome === "aborted"
                            ? "text-red-300"
                            : "text-amber-300",
                      )}
                    >
                      {link.lastReroll.outcome === "confirmed"
                        ? "success"
                        : link.lastReroll.outcome === "aborted"
                          ? "failed"
                          : "in progress"}
                    </span>
                    <span className="text-zinc-500">· {new Date(link.lastReroll.at).toLocaleString()}</span>
                  </span>
                </div>
              )}
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                disabled={unlinkMutation.isPending}
                onClick={() => unlinkMutation.mutate()}
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3.5 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-red-500/50 hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {unlinkMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Unlink className="h-4 w-4" aria-hidden />}
                Unlink
              </button>
            </div>
          </>
        ) : linkLoadFailed ? (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <p className="flex items-center gap-1.5 text-sm text-amber-200/90">
              <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden /> Couldn&rsquo;t read this site&rsquo;s link
              state — the console or connector may be briefly unreachable. This does not mean the site is unlinked; retry
              before enrolling.
            </p>
            <button
              type="button"
              onClick={() => void refetchLink()}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2 text-sm font-medium text-amber-200 transition-colors hover:bg-amber-500/20"
            >
              <RefreshCw className="h-4 w-4" aria-hidden /> Retry
            </button>
          </div>
        ) : (
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="flex items-center gap-1.5 text-sm text-zinc-500">
              <Fingerprint className="h-4 w-4" aria-hidden /> Not linked yet — enrollment runs entirely inside the
              cluster and confirms key fingerprints automatically.
            </p>
            <button
              type="button"
              disabled={enrollMutation.isPending}
              onClick={() => enrollMutation.mutate()}
              className="inline-flex items-center gap-2 rounded-lg bg-sky-500 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {enrollMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Link2 className="h-4 w-4" aria-hidden />}
              {enrollMutation.isPending ? "Enrolling…" : "Enable connector"}
            </button>
          </div>
        )}
      </section>

      {/* Plan & entitlements — the commercial tier and what it unlocks on the site */}
      {link && (
        <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-zinc-200">
              <Sparkles className="h-5 w-5 text-amber-300" aria-hidden />
              <h2 className="text-lg font-medium">Plan &amp; entitlements</h2>
            </div>
            <TierBadge tierId={currentTierId} />
          </div>
          <p className="mt-1 max-w-prose text-sm text-zinc-400">
            This site&rsquo;s paid tier decides which Plus features unlock. Assigning a tier pushes its feature set to
            the plugin over the <span className="text-zinc-300">signed command channel</span> — the site can never
            grant itself a tier or a feature, it can only receive one the console signed.
          </p>

          {/* What the current tier grants — every known feature with its on/off state */}
          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Features on the {currentTier.displayName} tier
            </p>
            <ul className="mt-2.5 grid gap-2 sm:grid-cols-2">
              {ENTITLEMENT_FLAGS.map((flag) => {
                const on = grantedFlags[flag] === true;
                const meta = ENTITLEMENT_FLAG_META[flag];
                return (
                  <li key={flag} className="flex items-start gap-2">
                    {on ? (
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" aria-label="granted" />
                    ) : (
                      <Minus className="mt-0.5 h-4 w-4 shrink-0 text-zinc-600" aria-label="not granted" />
                    )}
                    <span className="min-w-0">
                      <span className={cn("text-sm font-medium", on ? "text-zinc-100" : "text-zinc-500")}>
                        {meta.label}
                      </span>
                      <span className="block text-xs text-zinc-500">{meta.description}</span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Communication status — the console↔plugin signed exchange, made legible */}
          <div className="mt-3 grid gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="shrink-0 text-zinc-500">Last pushed to site</span>
              {link.entitlements?.updatedAt ? (
                <span className="inline-flex items-center gap-1.5 truncate text-right font-mono text-emerald-300">
                  <BadgeCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>acknowledged {timeAgo(link.entitlements.updatedAt)}</span>
                  {link.entitlements.updatedBy && <span className="text-zinc-500">· by {link.entitlements.updatedBy}</span>}
                </span>
              ) : (
                <span className="font-mono text-zinc-500">never pushed</span>
              )}
            </div>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="shrink-0 text-zinc-500">Last verified contact</span>
              {link.lastHealth ? (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 font-mono",
                    isHealthStale(link.lastHealth.at) ? "text-amber-300" : "text-zinc-300",
                  )}
                >
                  {timeAgo(link.lastHealth.at)}
                  {isHealthStale(link.lastHealth.at) && (
                    <span className="inline-flex items-center gap-1 text-amber-400">
                      <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden /> stale
                    </span>
                  )}
                </span>
              ) : (
                <span className="font-mono text-zinc-500">never</span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-zinc-500">
              The plugin re-checks this signed heartbeat locally — if it goes stale, the Plus features lock on the site
              until the next verified sweep. The console mirror above is authoritative regardless.
            </p>
          </div>

          {/* Assign a tier */}
          <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
            <div className="min-w-0 grow">
              <label htmlFor={`tier-${site}`} className="text-xs font-medium text-zinc-400">
                Assign tier
              </label>
              <select
                id={`tier-${site}`}
                value={selectedTier}
                disabled={!commandable || identitySuspended || entitlementsBusy}
                onChange={(e) => {
                  if (isTierId(e.target.value)) setSelectedTier(e.target.value);
                }}
                className="mt-1 block w-full max-w-xs rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {listTiers().map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.displayName}
                  </option>
                ))}
              </select>
              <p className="mt-1 max-w-prose text-xs text-zinc-500">{TIERS[selectedTier].description}</p>
            </div>
            <button
              type="button"
              disabled={!commandable || identitySuspended || entitlementsBusy || !tierDirty}
              title={
                identitySuspended
                  ? "Suspended — confirm the site's identity first"
                  : !tierDirty
                    ? "Already on this tier"
                    : undefined
              }
              onClick={() => tierMutation.mutate(selectedTier)}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-sky-500 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {tierMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Sparkles className="h-4 w-4" aria-hidden />
              )}
              {tierMutation.isPending ? "Applying…" : tierDirty ? `Apply ${TIERS[selectedTier].displayName}` : "Applied"}
            </button>
          </div>

          {/* Revoke — the distinct, destructive off-switch with a confirm step */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-500/20 bg-red-500/5 p-3">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-medium text-red-200">
                <Ban className="h-4 w-4" aria-hidden /> Revoke entitlements
              </p>
              <p className="mt-0.5 max-w-prose text-xs text-zinc-400">
                Moves the site back to <span className="font-medium text-zinc-300">Free</span> and clears every paid
                flag over the signed channel. The Plus features lock on the site right away.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {revokeArmed && !isFreeTier && (
                <button
                  type="button"
                  onClick={() => setRevokeArmed(false)}
                  className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-500"
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                disabled={!commandable || identitySuspended || entitlementsBusy || isFreeTier}
                title={
                  identitySuspended
                    ? "Suspended — confirm the site's identity first"
                    : isFreeTier
                      ? "Already on Free — nothing to revoke"
                      : undefined
                }
                onClick={() => (revokeArmed ? revokeMutation.mutate() : setRevokeArmed(true))}
                className={cn(
                  "inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                  revokeArmed && !isFreeTier
                    ? "bg-red-500 text-white hover:bg-red-400"
                    : "border border-red-500/40 bg-transparent text-red-300 hover:bg-red-500/10",
                )}
              >
                {revokeMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Ban className="h-4 w-4" aria-hidden />
                )}
                {revokeMutation.isPending ? "Revoking…" : revokeArmed && !isFreeTier ? "Confirm revoke" : "Revoke"}
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Release channel — which Connector release train the update sweep targets */}
      {link && (
        <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-zinc-200">
              <GitBranch className="h-5 w-5 text-violet-300" aria-hidden />
              <h2 className="text-lg font-medium">Release channel</h2>
            </div>
            <ChannelBadge channel={currentChannel} />
          </div>
          <p className="mt-1 max-w-prose text-sm text-zinc-400">
            Which Connector release train this site rides. Orthogonal to the plan above — the channel decides{" "}
            <span className="text-zinc-300">which version</span> the update sweep installs, not what the site is
            entitled to. Assigning a channel is pure console bookkeeping; the version only lands when you run the update
            sweep, so a site can never move itself onto a less-stable train.
          </p>

          <div className="mt-4 flex flex-wrap items-end gap-x-3 gap-y-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
            <div className="min-w-0 grow">
              <label htmlFor={`channel-${site}`} className="text-xs font-medium text-zinc-400">
                Assign channel
              </label>
              <select
                id={`channel-${site}`}
                value={selectedChannel}
                disabled={channelMutation.isPending}
                onChange={(e) => {
                  if (isReleaseChannel(e.target.value)) setSelectedChannel(e.target.value);
                }}
                className="mt-1 block w-full max-w-xs rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {listChannels().map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 max-w-prose text-xs text-zinc-500">{CHANNELS[selectedChannel].blurb}</p>
            </div>
            <button
              type="button"
              disabled={channelMutation.isPending || !channelDirty}
              title={!channelDirty ? "Already on this channel" : undefined}
              onClick={() => channelMutation.mutate(selectedChannel)}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-violet-500 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {channelMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <GitBranch className="h-4 w-4" aria-hidden />
              )}
              {channelMutation.isPending
                ? "Applying…"
                : channelDirty
                  ? `Move to ${CHANNELS[selectedChannel].label}`
                  : "Applied"}
            </button>
          </div>
        </section>
      )}

      {/* Security — key rotation, quarantine, kill switch */}
      <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <div className="flex items-center gap-2 text-zinc-200">
          <ShieldCheck className="h-5 w-5 text-emerald-400" aria-hidden />
          <h2 className="text-lg font-medium">Security</h2>
        </div>

        <div className="mt-4 grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-100">Reroll signing key</p>
              <p className="mt-0.5 text-xs text-zinc-400">
                Rotates the site&rsquo;s response-signing key (prepare → verify → confirm). The old key is destroyed
                on confirm and can never come back.
              </p>
            </div>
            <button
              type="button"
              disabled={!commandable || rotateMutation.isPending || identitySuspended}
              title={identitySuspended ? "Suspended — confirm the site's identity first" : undefined}
              onClick={() => rotateMutation.mutate()}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-emerald-500 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {rotateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <KeyRound className="h-4 w-4" aria-hidden />}
              {rotateMutation.isPending ? "Rotating…" : "Reroll key"}
            </button>
          </div>

          {/* §8 — per-site automatic key-rotation schedule (operator-tunable age gate). */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-zinc-100">Automatic key rotation</p>
                <p className="mt-0.5 text-xs text-zinc-400">
                  How old this site&rsquo;s signing key may get before the scheduled sweep rerolls it. Per site,
                  independent of the fleet default. Manual <span className="font-medium text-zinc-300">Reroll key</span> above
                  always works regardless of this setting.
                </p>
              </div>
              <label className="inline-flex shrink-0 items-center gap-2 text-sm text-zinc-200">
                <input
                  type="checkbox"
                  checked={rotAuto}
                  onChange={(e) => setRotAuto(e.target.checked)}
                  className="h-4 w-4 rounded border-zinc-600 bg-zinc-900 accent-emerald-500"
                />
                Auto-rotate
              </label>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label className="text-xs text-zinc-400" htmlFor={`rot-interval-${site}`}>
                Rotate every
              </label>
              <input
                id={`rot-interval-${site}`}
                type="number"
                min={1}
                max={rotUnit === "days" ? 365 : 8760}
                value={rotValue}
                disabled={!rotAuto || policyMutation.isPending}
                onChange={(e) => setRotValue(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                className="w-20 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 disabled:opacity-50"
              />
              <select
                value={rotUnit}
                disabled={!rotAuto || policyMutation.isPending}
                onChange={(e) => setRotUnit(e.target.value === "hours" ? "hours" : "days")}
                className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 disabled:opacity-50"
              >
                <option value="hours">hours</option>
                <option value="days">days</option>
              </select>
              <button
                type="button"
                disabled={!link || policyMutation.isPending}
                onClick={() =>
                  policyMutation.mutate({
                    autoRotate: rotAuto,
                    ...(rotAuto
                      ? { intervalMs: rotValue * (rotUnit === "days" ? MS_PER_DAY : MS_PER_HOUR) }
                      : {}),
                  })
                }
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-100 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {policyMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Save schedule
              </button>
              <span className="text-xs text-zinc-500">
                {rotAuto
                  ? link?.rotationPolicy?.intervalMs
                    ? "Custom schedule active"
                    : "Using fleet default (30 days)"
                  : "Scheduled rotation off"}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-100">
                {link?.state === "quarantined" ? "Release quarantine" : "Quarantine link"}
              </p>
              <p className="mt-0.5 text-xs text-zinc-400">
                {link?.state === "quarantined"
                  ? "Allow signed commands again and reset the rejection counter."
                  : "Immediately blocks all signed commands to this site without touching the plugin."}
              </p>
            </div>
            <button
              type="button"
              disabled={!linked || quarantineMutation.isPending || (link?.state !== "active" && link?.state !== "quarantined")}
              onClick={() => quarantineMutation.mutate(link?.state === "quarantined")}
              className={cn(
                "inline-flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                link?.state === "quarantined" ? "bg-emerald-500 hover:bg-emerald-400" : "bg-amber-600 hover:bg-amber-500",
              )}
            >
              {quarantineMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ShieldBan className="h-4 w-4" aria-hidden />}
              {link?.state === "quarantined" ? "Release" : "Quarantine"}
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-500/20 bg-red-500/5 p-3">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-medium text-red-200">
                <AlertTriangle className="h-4 w-4" aria-hidden /> Kill switch
              </p>
              <p className="mt-0.5 text-xs text-zinc-400">
                Orders the plugin to wipe its keys and all link state, then destroys the link record and uninstalls
                the plugin. Re-enrolling starts from scratch.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {killArmed && (
                <button
                  type="button"
                  onClick={() => setKillArmed(false)}
                  className="rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-500"
                >
                  Cancel
                </button>
              )}
              <button
                type="button"
                disabled={!linked || killMutation.isPending}
                onClick={() => (killArmed ? killMutation.mutate() : setKillArmed(true))}
                className={cn(
                  "inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                  killArmed ? "bg-red-500 hover:bg-red-400" : "border border-red-500/40 bg-transparent text-red-300 hover:bg-red-500/10",
                )}
              >
                {killMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ShieldBan className="h-4 w-4" aria-hidden />}
                {killMutation.isPending ? "Destroying…" : killArmed ? "Confirm destroy" : "Deactivate & wipe"}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Debugging — signed health check + deep diagnostics + plugin update */}
      <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-zinc-200">
            <Bug className="h-5 w-5 text-violet-400" aria-hidden />
            <h2 className="text-lg font-medium">Debugging</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!commandable || healthMutation.isPending}
              onClick={() => healthMutation.mutate()}
              className="inline-flex items-center gap-2 rounded-lg bg-violet-500 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {healthMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Activity className="h-4 w-4" aria-hidden />}
              Health check
            </button>
            <button
              type="button"
              disabled={!linked || debugMutation.isPending}
              onClick={() => debugMutation.mutate()}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3.5 py-2 text-sm text-zinc-200 transition-colors hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {debugMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Bug className="h-4 w-4" aria-hidden />}
              Run diagnostics
            </button>
          </div>
        </div>
        <p className="mt-1 max-w-prose text-sm text-zinc-400">
          Health check does a full signed round-trip through the plugin. Diagnostics also run the plugin&rsquo;s
          crypto selftest and dump its link state — useful even when the signed channel is broken.
        </p>

        {health && (
          <div className="mt-4 grid gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
            <MetaRow label="Signed round-trip" value={`${health.roundtripMs} ms`} />
            <MetaRow label="Result" value={health.ok ? "ok" : health.rejectedReason ?? "failed"} tone={health.ok ? undefined : "danger"} />
            {typeof health.result.php === "string" && <MetaRow label="PHP" value={health.result.php} />}
            {typeof health.result.plugin === "string" && <MetaRow label="Plugin version" value={health.result.plugin} />}
            {typeof health.result.kid === "number" && <MetaRow label="Signing epoch" value={`${health.result.kid}`} />}
          </div>
        )}

        {debug && (
          <div className="mt-4 grid gap-3">
            {debug.debug ? (
              <div className="grid gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                {Object.entries(debug.debug).map(([key, value]) => (
                  <MetaRow key={key} label={key} value={value === null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value)} />
                ))}
              </div>
            ) : (
              debug.debugUnavailable && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-300">
                  {debug.debugUnavailable}
                </div>
              )
            )}
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Selftest</p>
              <pre className="mt-1 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-300">{debug.selftestText || "(no output)"}</pre>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Link status (wp-cli)</p>
              <pre className="mt-1 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-300">{debug.statusText || "(no output)"}</pre>
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-medium text-zinc-100">
              Update Connector plugin
              {updateAvailable && (
                <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-300">
                  <CircleArrowUp className="h-3 w-3" aria-hidden /> update available
                </span>
              )}
            </p>
            <p className="mt-0.5 text-xs text-zinc-400">
              Reinstalls the plugin from the console&rsquo;s bundled version in place — keys, epochs and link state
              are untouched.
              {updateAvailable && link?.connectorVersion && bundledConnectorVersion && (
                <span className="text-amber-300/90">
                  {" "}
                  Running {link.connectorVersion}, bundle ships {bundledConnectorVersion}.
                </span>
              )}
            </p>
          </div>
          <button
            type="button"
            disabled={!linked || updateMutation.isPending || identitySuspended}
            title={identitySuspended ? "Suspended — confirm the site's identity first" : undefined}
            onClick={() => updateMutation.mutate()}
            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-zinc-700 px-3.5 py-2 text-sm text-zinc-200 transition-colors hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {updateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CircleArrowUp className="h-4 w-4" aria-hidden />}
            {updateMutation.isPending ? "Updating…" : "Update plugin"}
          </button>
        </div>
      </section>
    </div>
  );
}
