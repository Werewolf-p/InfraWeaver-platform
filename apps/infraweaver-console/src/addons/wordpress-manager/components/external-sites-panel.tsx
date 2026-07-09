"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Download,
  Fingerprint,
  Link2,
  Loader2,
  Plus,
  RadioTower,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { cn, timeAgo } from "@/lib/utils";
import { toast } from "@/lib/notify";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/**
 * IWSL external sites (design §5 enrollment + §12.5 link-state card).
 * Flow: Add site → download .iwenroll bundle → operator uploads it to the
 * Connector plugin (or `wp infraweaver enroll`) → Verify (IW pulls the passive
 * enroll-proof) → operator compares key fingerprints against the plugin →
 * Confirm. Commands stay blocked until the fingerprint is confirmed.
 */

type ExternalSiteState = "pending" | "active" | "quarantined";

interface ExternalSite {
  siteId: string;
  name: string;
  url: string;
  state: ExternalSiteState;
  fingerprintConfirmed: boolean;
  createdAt: string;
  createdBy: string;
  bundleIssuedAt?: string;
  bundleExpiresAt?: string;
  activatedAt?: string;
  kid: number;
  epochFloor: number;
  iwKid: number;
  lastVerify?: { at: string; ok: boolean; reason?: string };
  lastHealth?: { at: string; ok: boolean; roundtripMs?: number; reason?: string };
  rejections: number;
  wpFingerprint: string | null;
  iwFingerprint: string;
  bundleValid: boolean;
  /** §5.1 managed links belong to a provisioned site's own settings card. */
  managed?: boolean;
  siteName?: string;
}

interface VerifyOutcome {
  ok: boolean;
  reason?: string;
  site: ExternalSite | null;
}

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

async function fetchExternalSites(): Promise<ExternalSite[]> {
  const res = await fetch("/api/wordpress/external-sites");
  if (!res.ok) throw new Error("Failed to load external sites");
  return ((await res.json()) as { sites: ExternalSite[] }).sites;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

function StateBadge({ site }: { site: ExternalSite }) {
  if (site.state === "active" && site.fingerprintConfirmed) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-green-500/30 bg-green-500/15 px-2 py-0.5 text-xs text-green-300">
        <CheckCircle2 className="h-3 w-3" aria-hidden /> Linked
      </span>
    );
  }
  if (site.state === "active") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">
        <Fingerprint className="h-3 w-3" aria-hidden /> Confirm fingerprints
      </span>
    );
  }
  if (site.state === "quarantined") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/15 px-2 py-0.5 text-xs text-red-300">
        <AlertTriangle className="h-3 w-3" aria-hidden /> Quarantined
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/15 px-2 py-0.5 text-xs text-sky-300">
      <CircleDashed className="h-3 w-3 animate-pulse" aria-hidden /> Pending enrollment
    </span>
  );
}

/** One §12.5 field: label left, value right, mono where it's key material. */
function LinkField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-zinc-500">{label}</span>
      <span className={cn("truncate text-right text-zinc-300", mono && "font-mono")}>{value}</span>
    </div>
  );
}

/** A health result older than this is flagged stale — the hourly sweep is overdue. */
const HEALTH_STALE_MS = 90 * 60 * 1000;

// Plain helper so the impure Date.now() read stays out of component render.
function isHealthStale(at: string) {
  return Date.now() - new Date(at).getTime() > HEALTH_STALE_MS;
}

/**
 * At-a-glance connector health: a ✓/✗ glyph for the last sweep verdict plus a
 * relative "checked" time, with a stale flag once the result passes 90 minutes.
 * A stale-but-passing check reads as a warning, not as healthy.
 */
function HealthField({ lastHealth }: { lastHealth?: ExternalSite["lastHealth"] }) {
  if (!lastHealth) {
    return <LinkField label="Last health check" value="never checked" />;
  }
  const stale = isHealthStale(lastHealth.at);
  const { ok } = lastHealth;
  const Icon = ok ? CheckCircle2 : XCircle;
  const color = !ok ? "text-red-300" : stale ? "text-amber-300" : "text-emerald-300";
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="shrink-0 text-zinc-500">Last health check</span>
      <span className={cn("inline-flex items-center gap-1.5", color)}>
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {ok ? "pass" : "fail"}
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

export function ExternalSitesPanel() {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [toDelete, setToDelete] = useState<ExternalSite | null>(null);
  const [compare, setCompare] = useState<ExternalSite | null>(null);
  const [pasteFor, setPasteFor] = useState<string | null>(null);
  const [pastedProof, setPastedProof] = useState("");

  const { data: allSites = [], isLoading } = useQuery({
    queryKey: ["wordpress-external-sites"],
    queryFn: fetchExternalSites,
    refetchInterval: 15000,
  });
  // Managed (§5.1) links live on their own site's settings card — this panel
  // is strictly the "hosted elsewhere" fleet.
  const sites = allSites.filter((site) => !site.managed);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["wordpress-external-sites"] });

  const createMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/wordpress/external-sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, url }),
      });
      if (!res.ok) throw new Error(await readError(res, "Failed to add external site"));
      return ((await res.json()) as { site: ExternalSite }).site;
    },
    onSuccess: () => {
      toast.success("External site registered — download its enrollment bundle next");
      setName("");
      setUrl("");
      setAdding(false);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to add external site"),
  });

  const verifyMutation = useMutation({
    mutationFn: async ({ siteId, proof }: { siteId: string; proof?: string }) => {
      const res = await fetch(`/api/wordpress/external-sites/${siteId}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(proof === undefined ? {} : { proof }),
      });
      // 422 carries a structured §12.5 rejection reason, not a transport error.
      if (!res.ok && res.status !== 422) throw new Error(await readError(res, "Verification failed"));
      return (await res.json()) as VerifyOutcome;
    },
    onSuccess: (outcome) => {
      if (outcome.ok && outcome.site) {
        toast.success("Proof verified and WP key pinned — now compare fingerprints");
        setPasteFor(null);
        setPastedProof("");
        setCompare(outcome.site);
      } else {
        toast.error(`Verification rejected: ${outcome.reason ?? "unknown"}`);
      }
      invalidate();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Verification failed"),
  });

  const confirmMutation = useMutation({
    mutationFn: async (siteId: string) => {
      const res = await fetch(`/api/wordpress/external-sites/${siteId}/confirm`, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res, "Failed to confirm fingerprints"));
    },
    onSuccess: () => {
      toast.success("Fingerprints confirmed — site link established");
      setCompare(null);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to confirm fingerprints"),
  });

  const bundleMutation = useMutation({
    // POST (not a plain <a href> GET): issuing a bundle mints a fresh
    // single-use secret, so it must be CSRF-safe; the download is saved from
    // the response blob.
    mutationFn: async (site: ExternalSite) => {
      const res = await fetch(`/api/wordpress/external-sites/${site.siteId}/bundle`, { method: "POST" });
      if (!res.ok) throw new Error(await readError(res, "Failed to issue enrollment bundle"));
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `infraweaver-enroll-${site.siteId}.iwenroll`;
      return { blob: await res.blob(), filename };
    },
    onSuccess: ({ blob, filename }) => {
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(href);
      toast.success("Bundle downloaded — upload it to the Connector plugin within 15 minutes");
      invalidate();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to issue enrollment bundle"),
  });

  const deleteMutation = useMutation({
    mutationFn: async (siteId: string) => {
      const res = await fetch(`/api/wordpress/external-sites/${siteId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res, "Failed to remove site"));
    },
    onSuccess: () => {
      toast.success("External site removed");
      setToDelete(null);
      invalidate();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to remove site"),
  });

  const canSubmit = name.trim().length > 0 && url.trim().startsWith("https://") && !createMutation.isPending;

  return (
    <section className="mt-12">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-zinc-100">
            <RadioTower className="h-5 w-5 text-sky-400" aria-hidden />
            <h2 className="text-lg font-semibold tracking-tight">External sites</h2>
          </div>
          <p className="max-w-prose text-sm text-zinc-400">
            WordPress sites hosted elsewhere, linked over the signed IWSL protocol. The site never
            connects to InfraWeaver — enrollment is a one-time bundle upload plus a verification pull.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/api/wordpress/external-sites/plugin"
            download
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
            title="The InfraWeaver Connector plugin zip — upload it to the external site (or unzip into wp-content/plugins) before enrolling"
          >
            <Download className="h-4 w-4" aria-hidden /> Download plugin
          </a>
          <button
            type="button"
            onClick={() => setAdding((open) => !open)}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          >
            <Plus className="h-4 w-4" aria-hidden /> Add external site
          </button>
        </div>
      </header>

      <AnimatePresence initial={false}>
        {adding && (
          <motion.form
            key="add-external"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: EASE_OUT }}
            className="overflow-hidden"
            onSubmit={(event) => {
              event.preventDefault();
              if (canSubmit) createMutation.mutate();
            }}
          >
            <div className="mt-4 space-y-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="text-zinc-400">Display name</span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Customer blog"
                    maxLength={80}
                    className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-zinc-400">Site URL (https)</span>
                  <input
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                    placeholder="https://blog.example.com"
                    className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
                  />
                </label>
              </div>
              <div className="flex items-center justify-end gap-3">
                <button type="button" onClick={() => setAdding(false)} className="text-sm text-zinc-400 hover:text-zinc-200">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!canSubmit}
                  className="inline-flex items-center gap-2 rounded-lg bg-sky-500 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                  Register site
                </button>
              </div>
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      <div className="mt-6">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading external sites…
          </div>
        ) : sites.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 px-6 py-10 text-center">
            <Link2 className="mx-auto h-7 w-7 text-zinc-600" aria-hidden />
            <p className="mt-3 text-sm font-medium text-zinc-300">No external sites linked</p>
            <p className="mt-1 text-sm text-zinc-500">
              Add one to manage a WordPress installation hosted outside the cluster.
            </p>
          </div>
        ) : (
          <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
            {sites.map((site) => (
              <li
                key={site.siteId}
                className="group flex flex-col gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 transition-colors hover:border-zinc-700"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-zinc-100">{site.name}</p>
                    <p className="truncate font-mono text-xs text-zinc-500">{site.url}</p>
                  </div>
                  <StateBadge site={site} />
                </div>

                {/* §12.5 link-state card */}
                <div className="space-y-1.5 rounded-lg border border-zinc-800/80 bg-zinc-950/50 p-3">
                  <LinkField label="IW-PK fingerprint" value={site.iwFingerprint} mono />
                  <LinkField label="WP-PK fingerprint" value={site.wpFingerprint ?? "— not pinned yet"} mono={!!site.wpFingerprint} />
                  <LinkField label="Key epoch (kid / floor)" value={site.state === "active" ? `${site.kid} / ${site.epochFloor}` : "—"} />
                  <LinkField label="Sequence" value="— (command dispatch lands with phase 4)" />
                  <LinkField label="Rotation phase" value="idle" />
                  <LinkField
                    label="Last verify"
                    value={
                      site.lastVerify
                        ? `${new Date(site.lastVerify.at).toLocaleString()} — ${site.lastVerify.ok ? "ok" : site.lastVerify.reason ?? "rejected"}`
                        : "never"
                    }
                  />
                  <HealthField lastHealth={site.lastHealth} />
                  <LinkField label="Rejections" value={String(site.rejections)} />
                  {site.state === "pending" && site.bundleIssuedAt && (
                    <LinkField
                      label="Bundle"
                      value={site.bundleValid ? `valid until ${new Date(site.bundleExpiresAt!).toLocaleTimeString()}` : "expired — re-download"}
                    />
                  )}
                </div>

                {pasteFor === site.siteId && (
                  <div className="space-y-2">
                    <textarea
                      value={pastedProof}
                      onChange={(event) => setPastedProof(event.target.value)}
                      placeholder='Paste the enroll-proof JSON shown by the plugin ({"proof":…,"sigs":…})'
                      rows={3}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
                    />
                    <div className="flex justify-end gap-3">
                      <button type="button" onClick={() => setPasteFor(null)} className="text-xs text-zinc-400 hover:text-zinc-200">
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={pastedProof.trim().length === 0 || verifyMutation.isPending}
                        onClick={() => verifyMutation.mutate({ siteId: site.siteId, proof: pastedProof })}
                        className="rounded-md bg-sky-500 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-400 disabled:opacity-50"
                      >
                        Verify pasted proof
                      </button>
                    </div>
                  </div>
                )}

                <div className="mt-auto flex flex-wrap items-center gap-2">
                  {site.state === "pending" && (
                    <>
                      <button
                        type="button"
                        disabled={bundleMutation.isPending}
                        onClick={() => bundleMutation.mutate(site)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:border-zinc-600 hover:text-white disabled:opacity-50"
                      >
                        {bundleMutation.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        ) : (
                          <Download className="h-3.5 w-3.5" aria-hidden />
                        )}
                        Download bundle
                      </button>
                      <button
                        type="button"
                        disabled={verifyMutation.isPending}
                        onClick={() => verifyMutation.mutate({ siteId: site.siteId })}
                        className="inline-flex items-center gap-1.5 rounded-md bg-sky-500 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-sky-400 disabled:opacity-50"
                      >
                        {verifyMutation.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        ) : (
                          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                        )}
                        Verify
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPasteFor(site.siteId);
                          setPastedProof("");
                        }}
                        className="text-xs text-zinc-500 hover:text-zinc-300"
                      >
                        paste proof instead
                      </button>
                    </>
                  )}
                  {site.state === "active" && !site.fingerprintConfirmed && (
                    <button
                      type="button"
                      onClick={() => setCompare(site)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-amber-500 px-2.5 py-1.5 text-xs font-medium text-zinc-950 hover:bg-amber-400"
                    >
                      <Fingerprint className="h-3.5 w-3.5" aria-hidden /> Compare fingerprints
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setToDelete(site)}
                    className="ml-auto rounded-md p-1.5 text-zinc-500 opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-400 focus-visible:opacity-100 group-hover:opacity-100"
                    aria-label={`Remove ${site.name}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* §5 step 3 — mandatory-manual fingerprint comparison for external sites. */}
      {compare && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Compare key fingerprints">
          <div className="w-full max-w-lg rounded-xl border border-zinc-700 bg-zinc-900 p-6 shadow-xl">
            <div className="flex items-center gap-2 text-zinc-100">
              <Fingerprint className="h-5 w-5 text-amber-400" aria-hidden />
              <h3 className="text-lg font-semibold">Compare key fingerprints</h3>
            </div>
            <p className="mt-2 text-sm text-zinc-400">
              On the site, run <code className="rounded bg-zinc-950 px-1.5 py-0.5 font-mono text-xs text-zinc-300">wp infraweaver status</code>{" "}
              (or open the plugin&apos;s status panel) and check that <em>both</em> fingerprints match
              exactly. This comparison is what defeats a machine-in-the-middle during enrollment —
              do not confirm on a mismatch.
            </p>
            <dl className="mt-4 space-y-3">
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                <dt className="text-xs text-zinc-500">IW-PK fingerprint (this console)</dt>
                <dd className="mt-1 font-mono text-xl tracking-wide text-sky-300">{compare.iwFingerprint}</dd>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                <dt className="text-xs text-zinc-500">WP-PK fingerprint (pinned from the site)</dt>
                <dd className="mt-1 font-mono text-xl tracking-wide text-sky-300">{compare.wpFingerprint ?? "—"}</dd>
              </div>
            </dl>
            <div className="mt-5 flex items-center justify-end gap-3">
              <button type="button" onClick={() => setCompare(null)} className="text-sm text-zinc-400 hover:text-zinc-200">
                Not now
              </button>
              <button
                type="button"
                disabled={confirmMutation.isPending}
                onClick={() => confirmMutation.mutate(compare.siteId)}
                className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50"
              >
                {confirmMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                Both fingerprints match
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={toDelete !== null}
        title={`Remove ${toDelete?.name ?? "external site"}?`}
        description="This deletes the link record and burns any outstanding enrollment secret. The Connector plugin on the site keeps its state — deactivate it there too (site.deactivate arrives with command dispatch)."
        confirmText="Remove site"
        danger
        onConfirm={() => {
          if (toDelete) deleteMutation.mutate(toDelete.siteId);
        }}
        onCancel={() => setToDelete(null)}
      />
    </section>
  );
}
