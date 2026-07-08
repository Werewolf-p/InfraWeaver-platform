"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bug,
  CheckCircle2,
  CircleArrowUp,
  CircleDashed,
  Fingerprint,
  KeyRound,
  Link2,
  Loader2,
  ShieldBan,
  ShieldCheck,
  Unlink,
  XCircle,
} from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import { toast } from "@/lib/notify";
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
  pendingRotation?: { newKid: number; phase: string } | null;
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

async function fetchManagedLink(site: string): Promise<ManagedLink | null> {
  const res = await fetch(`/api/wordpress/sites/${site}/iwsl`);
  if (!res.ok) throw new Error("Failed to load connector link state");
  return ((await res.json()) as { link: ManagedLink | null }).link;
}

async function postOp<T>(site: string, action: string): Promise<T> {
  const res = await fetch(`/api/wordpress/sites/${site}/iwsl/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Operation failed");
  return res.json() as Promise<T>;
}

function StateBadge({ link }: { link: ManagedLink | null }) {
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

  const { data: link, isLoading: linkLoading } = useQuery({
    queryKey: ["wordpress-iwsl-link", site],
    queryFn: () => fetchManagedLink(site),
  });

  const refetchLink = () => void queryClient.invalidateQueries({ queryKey: ["wordpress-iwsl-link", site] });

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

  const linked = Boolean(link);
  const commandable = link?.state === "active" && link.fingerprintConfirmed;
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
        <StateBadge link={link ?? null} />
      </header>

      <SiteTabs site={site} active="connector" />

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
              {(commandable || link.lastHealth) && <HealthRow lastHealth={link.lastHealth} />}
              {link.lastVerify && !link.lastVerify.ok && (
                <MetaRow label="Last verify" value={link.lastVerify.reason ?? "failed"} tone="danger" />
              )}
              {link.rejections > 0 && <MetaRow label="Rejections seen" value={`${link.rejections}`} tone="danger" />}
              {link.pendingRotation && (
                <MetaRow label="Rotation in flight" value={`kid ${link.pendingRotation.newKid} (${link.pendingRotation.phase})`} />
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
              disabled={!commandable || rotateMutation.isPending}
              onClick={() => rotateMutation.mutate()}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-emerald-500 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {rotateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <KeyRound className="h-4 w-4" aria-hidden />}
              {rotateMutation.isPending ? "Rotating…" : "Reroll key"}
            </button>
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
            <p className="text-sm font-medium text-zinc-100">Update Connector plugin</p>
            <p className="mt-0.5 text-xs text-zinc-400">
              Reinstalls the plugin from the console&rsquo;s bundled version in place — keys, epochs and link state
              are untouched.
            </p>
          </div>
          <button
            type="button"
            disabled={!linked || updateMutation.isPending}
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
