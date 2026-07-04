"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Loader2,
  KeyRound,
  Link2,
  Puzzle,
  CheckCircle2,
  CircleArrowUp,
  CircleDashed,
  Construction,
  ExternalLink,
  Fingerprint,
  Globe,
  Lock,
  ShieldCheck,
  Unlink,
  Users,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import { SiteRuntimeCard } from "./site-runtime-card";

type AuthMode = "none" | "login" | "admin" | "full";

interface SiteStatus {
  site: string;
  host: string;
  ready: boolean;
  replicas: number;
  domain?: string;
  internal?: boolean;
  authMode?: AuthMode;
  dnsWarning?: string;
}

interface SiteAccess {
  group: string;
  allowed: string[];
  /** WordPress role each allowed user gets from their RBAC grant. */
  roles?: Record<string, string>;
  /** Allowed users with no email on record — they can't get a WordPress account. */
  skippedNoEmail?: string[];
}

const AUTH_MODE_LABEL: Record<AuthMode, string> = {
  none: "Public",
  login: "Login protected",
  admin: "Admin + sensitive protected",
  full: "Behind Authentik",
};

/** Protection scopes, least → most restrictive, with what each one gates. */
const PROTECTION_SCOPES: { mode: AuthMode; label: string; detail: string }[] = [
  { mode: "none", label: "Public", detail: "No authentication — the whole site is open." },
  { mode: "login", label: "Login only", detail: "Only /wp-admin and /wp-login.php require Authentik." },
  { mode: "admin", label: "Sensitive", detail: "Login gated, plus xmlrpc / REST user enumeration / sensitive files are blocked." },
  { mode: "full", label: "Everything", detail: "The entire site sits behind Authentik." },
];

async function fetchAccess(site: string): Promise<SiteAccess> {
  const res = await fetch(`/api/wordpress/sites/${site}/access`);
  if (!res.ok) throw new Error("Failed to load access list");
  return res.json();
}

async function fetchSiteStatus(site: string): Promise<SiteStatus | null> {
  const res = await fetch("/api/wordpress/sites");
  if (!res.ok) throw new Error("Failed to load site status");
  const { sites } = (await res.json()) as { sites: SiteStatus[] };
  return sites.find((entry) => entry.site === site) ?? null;
}

interface PluginDef {
  slug: string;
  name: string;
  description: string;
  category: string;
  recommended?: boolean;
  sso?: boolean;
}

interface PluginsResponse {
  catalog: PluginDef[];
  /** null when the installed set could not be read (e.g. pod not running yet). */
  installed: string[] | null;
  installedError?: string | null;
}

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

async function fetchPlugins(site: string): Promise<PluginsResponse> {
  const res = await fetch(`/api/wordpress/sites/${site}/plugins`);
  if (!res.ok) throw new Error("Failed to load plugins");
  return res.json();
}

interface MaintenanceState {
  site: string;
  enabled: boolean;
}

async function fetchMaintenance(site: string): Promise<MaintenanceState> {
  const res = await fetch(`/api/wordpress/sites/${site}/maintenance`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to load maintenance state");
  return res.json();
}

/** Mirrors PluginUpdateResult in lib/plugins.ts (what wp-cli reports per plugin). */
interface PluginUpdateRow {
  slug: string;
  oldVersion: string | null;
  newVersion: string | null;
  status: string;
}

/** Slice of ExternalSiteView the connector card renders (§5.1 managed link). */
interface ManagedLink {
  siteId: string;
  state: "pending" | "active" | "quarantined";
  fingerprintConfirmed: boolean;
  activatedAt?: string;
  wpFingerprint: string | null;
  iwFingerprint: string;
  lastVerify?: { at: string; ok: boolean; reason?: string };
}

async function fetchManagedLink(site: string): Promise<ManagedLink | null> {
  const res = await fetch(`/api/wordpress/sites/${site}/iwsl`);
  if (!res.ok) throw new Error("Failed to load connector link state");
  return ((await res.json()) as { link: ManagedLink | null }).link;
}

export function SiteDetailView({ site }: { site: string }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [issuer, setIssuer] = useState("");
  const [pendingMode, setPendingMode] = useState<AuthMode | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["wordpress-plugins", site],
    queryFn: () => fetchPlugins(site),
  });

  const { data: status } = useQuery({
    queryKey: ["wordpress-site-status", site],
    queryFn: () => fetchSiteStatus(site),
    refetchInterval: 8000,
  });

  const { data: access } = useQuery({
    queryKey: ["wordpress-access", site],
    queryFn: () => fetchAccess(site),
  });

  const installed = new Set(data?.installed ?? []);
  const checked = selected ?? installed;
  // When the installed set is unknown, block edits so an empty default can't be
  // saved as "remove every plugin".
  const pluginsUnavailable = !isLoading && data?.installed == null;

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/wordpress/sites/${site}/plugins`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plugins: [...checked] }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Save failed");
    },
    onSuccess: () => {
      toast.success("Plugins updated");
      setSelected(null);
      void queryClient.invalidateQueries({ queryKey: ["wordpress-plugins", site] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const ssoMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/wordpress/sites/${site}/sso`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issuerBase: issuer }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Enabling SSO failed");
    },
    onSuccess: () => {
      toast.success("Authentik SSO enabled");
      void queryClient.invalidateQueries({ queryKey: ["wordpress-plugins", site] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const protectionMutation = useMutation({
    mutationFn: async (next: AuthMode) => {
      const res = await fetch(`/api/wordpress/sites/${site}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authMode: next }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to change protection");
    },
    onSuccess: () => {
      toast.success("Protection scope updated");
      setPendingMode(null);
      void queryClient.invalidateQueries({ queryKey: ["wordpress-site-status", site] });
      void queryClient.invalidateQueries({ queryKey: ["wordpress-access", site] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const syncAccessMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/wordpress/sites/${site}/access`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Sync failed");
    },
    onSuccess: () => {
      toast.success("Access synced with Authentik");
      void queryClient.invalidateQueries({ queryKey: ["wordpress-access", site] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const { data: maintenance, isError: maintenanceUnavailable } = useQuery({
    queryKey: ["wordpress-maintenance", site],
    queryFn: () => fetchMaintenance(site),
    retry: 1,
  });

  const { data: managedLink, isLoading: linkLoading } = useQuery({
    queryKey: ["wordpress-iwsl-link", site],
    queryFn: () => fetchManagedLink(site),
  });

  const enrollMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/wordpress/sites/${site}/iwsl`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Enrollment failed");
    },
    onSuccess: () => {
      toast.success("Connector installed and enrolled — the site is linked");
      void queryClient.invalidateQueries({ queryKey: ["wordpress-iwsl-link", site] });
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
      void queryClient.invalidateQueries({ queryKey: ["wordpress-iwsl-link", site] });
      void queryClient.invalidateQueries({ queryKey: ["wordpress-plugins", site] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const maintenanceMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await fetch(`/api/wordpress/sites/${site}/maintenance`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to change maintenance mode");
    },
    onSuccess: (_data, enabled) => {
      toast.success(enabled ? "Maintenance page is up — visitors now see it" : "Maintenance mode off — the site is live again");
      void queryClient.invalidateQueries({ queryKey: ["wordpress-maintenance", site] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const updateAllMutation = useMutation({
    mutationFn: async (): Promise<{ updated: PluginUpdateRow[] }> => {
      const res = await fetch(`/api/wordpress/sites/${site}/plugins/update`, { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Plugin update failed");
      return res.json();
    },
    onSuccess: ({ updated }) => {
      toast.success(updated.length === 0 ? "All plugins are already up to date" : `Plugin update finished (${updated.length} processed)`);
      void queryClient.invalidateQueries({ queryKey: ["wordpress-plugins", site] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const toggle = (slug: string) => {
    if (pluginsUnavailable) return;
    const next = new Set(checked);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    setSelected(next);
  };

  const dirty = selected !== null;
  // Mirror the backend, which requires https (see ssoSchema in api/handlers.ts).
  const issuerValid = /^https:\/\/.+/.test(issuer);

  const currentMode: AuthMode = status?.authMode ?? "none";
  const selectedMode = pendingMode ?? currentMode;
  const protectionDirty = pendingMode !== null && pendingMode !== currentMode;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <Link href="/wordpress" className="inline-flex items-center gap-1.5 text-sm text-zinc-400 hover:text-zinc-200">
        <ArrowLeft className="h-4 w-4" aria-hidden /> All sites
      </Link>

      <header className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">{site}</h1>
        {status && (
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs",
              status.ready
                ? "border-green-500/30 bg-green-500/15 text-green-300"
                : "border-amber-500/30 bg-amber-500/15 text-amber-300",
            )}
          >
            {status.ready ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : <CircleDashed className="h-3 w-3 animate-pulse" aria-hidden />}
            {status.ready ? "Ready" : "Starting"}
          </span>
        )}
      </header>

      {/* Status & domain — the management panel's at-a-glance summary */}
      <section className="mt-6 grid gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5 sm:grid-cols-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500">
            <Globe className="h-3.5 w-3.5" aria-hidden /> Address
          </p>
          {status ? (
            <a
              href={`https://${status.host}`}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 truncate text-sm text-sky-300 hover:text-sky-200"
            >
              {status.host} <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
            </a>
          ) : (
            <p className="mt-2 text-sm text-zinc-500">—</p>
          )}
          {status?.dnsWarning && <p className="mt-1 text-xs text-amber-400">{status.dnsWarning}</p>}
        </div>
        <div>
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500">
            <Lock className="h-3.5 w-3.5" aria-hidden /> Reachability
          </p>
          <p className="mt-2 text-sm text-zinc-200">{status?.internal ? "Internal only" : "Public"}</p>
        </div>
        <div>
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-zinc-500">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Authentik
          </p>
          <p className="mt-2 text-sm text-zinc-200">{AUTH_MODE_LABEL[status?.authMode ?? "none"]}</p>
        </div>
      </section>

      {/* The site as an app: its pods (WordPress + MariaDB) and their firewall */}
      <SiteRuntimeCard site={site} />

      <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-zinc-200">
            <Construction className="h-5 w-5 text-orange-400" aria-hidden />
            <h2 className="text-lg font-medium">Maintenance mode</h2>
          </div>
          {maintenance && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs",
                maintenance.enabled
                  ? "border-orange-500/30 bg-orange-500/15 text-orange-300"
                  : "border-zinc-700 bg-zinc-950/50 text-zinc-400",
              )}
            >
              {maintenance.enabled ? "Maintenance page up" : "Off"}
            </span>
          )}
        </div>
        <p className="mt-1 max-w-prose text-sm text-zinc-400">
          Shows visitors a &ldquo;temporarily unavailable&rdquo; page (HTTP 503) while you work on the site. Logged-in
          administrators keep full access, and the page stays up until you turn it off.
        </p>
        {maintenanceUnavailable && !maintenance ? (
          // Only replace the control when we have never read the state — a failed
          // background refetch keeps the last-known-good data, so the toggle stays.
          <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-300">
            Maintenance mode can&rsquo;t be read right now — the site may still be starting.
          </div>
        ) : (
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              aria-pressed={maintenance?.enabled ?? false}
              disabled={!maintenance || maintenanceMutation.isPending}
              onClick={() => maintenance && maintenanceMutation.mutate(!maintenance.enabled)}
              className={cn(
                "inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                maintenance?.enabled ? "bg-emerald-500 hover:bg-emerald-400" : "bg-orange-500 hover:bg-orange-400",
              )}
            >
              {maintenanceMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Construction className="h-4 w-4" aria-hidden />
              )}
              {maintenance?.enabled ? "Take out of maintenance" : "Enable maintenance"}
            </button>
          </div>
        )}
      </section>

      <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <div className="flex items-center gap-2 text-zinc-200">
          <KeyRound className="h-5 w-5 text-violet-400" aria-hidden />
          <h2 className="text-lg font-medium">Authentik single sign-on</h2>
        </div>
        <p className="mt-1 max-w-prose text-sm text-zinc-400">
          Provisions an OIDC provider and application in Authentik and configures WordPress to log in through it. The
          client secret is generated and stored in the vault — you never copy it by hand.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            value={issuer}
            onChange={(event) => setIssuer(event.target.value)}
            placeholder="https://auth.example.com"
            className="w-72 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500 focus:outline-none"
          />
          <button
            type="button"
            disabled={!issuerValid || ssoMutation.isPending}
            onClick={() => ssoMutation.mutate()}
            className="inline-flex items-center gap-2 rounded-lg bg-violet-500 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {ssoMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <KeyRound className="h-4 w-4" aria-hidden />}
            Enable SSO
          </button>
        </div>
      </section>

      <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <div className="flex items-center gap-2 text-zinc-200">
          <ShieldCheck className="h-5 w-5 text-emerald-400" aria-hidden />
          <h2 className="text-lg font-medium">Protection scope</h2>
        </div>
        <p className="mt-1 max-w-prose text-sm text-zinc-400">
          Choose how much of the site sits behind Authentik. Gated modes require SSO to be enabled (above).
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {PROTECTION_SCOPES.map(({ mode, label, detail }) => {
            const on = selectedMode === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => setPendingMode(mode)}
                aria-pressed={on}
                className={cn(
                  "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
                  on ? "border-emerald-500/50 bg-emerald-500/10" : "border-zinc-800 bg-zinc-950/40 hover:border-zinc-700",
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium text-zinc-100">{label}</span>
                  {currentMode === mode && <span className="text-[11px] uppercase tracking-wide text-emerald-300">current</span>}
                </span>
                <span className="text-xs text-zinc-400">{detail}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            disabled={!protectionDirty || protectionMutation.isPending}
            onClick={() => pendingMode && protectionMutation.mutate(pendingMode)}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {protectionMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ShieldCheck className="h-4 w-4" aria-hidden />}
            {protectionDirty ? "Apply protection" : "No changes"}
          </button>
        </div>
      </section>

      <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-zinc-200">
            <Link2 className="h-5 w-5 text-sky-400" aria-hidden />
            <h2 className="text-lg font-medium">InfraWeaver Connector</h2>
          </div>
          {managedLink && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs",
                managedLink.state === "active" && managedLink.fingerprintConfirmed
                  ? "border-green-500/30 bg-green-500/15 text-green-300"
                  : managedLink.state === "quarantined"
                    ? "border-red-500/30 bg-red-500/15 text-red-300"
                    : "border-sky-500/30 bg-sky-500/15 text-sky-300",
              )}
            >
              {managedLink.state === "active" && managedLink.fingerprintConfirmed ? (
                <><CheckCircle2 className="h-3 w-3" aria-hidden /> Linked</>
              ) : managedLink.state === "quarantined" ? (
                "Quarantined"
              ) : (
                <><CircleDashed className="h-3 w-3 animate-pulse" aria-hidden /> Pending</>
              )}
            </span>
          )}
        </div>
        <p className="mt-1 max-w-prose text-sm text-zinc-400">
          Installs the InfraWeaver Connector plugin and links this site over the signed IWSL protocol — the same
          management channel used for external sites. Enrollment runs entirely inside the cluster and the key
          fingerprints are confirmed automatically.
        </p>
        {managedLink ? (
          <>
            <div className="mt-4 grid gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="shrink-0 text-zinc-500">IW key fingerprint</span>
                <span className="truncate text-right font-mono text-zinc-300">{managedLink.iwFingerprint}</span>
              </div>
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="shrink-0 text-zinc-500">Site key fingerprint</span>
                <span className="truncate text-right font-mono text-zinc-300">{managedLink.wpFingerprint ?? "—"}</span>
              </div>
              {managedLink.activatedAt && (
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="shrink-0 text-zinc-500">Linked since</span>
                  <span className="truncate text-right text-zinc-300">{new Date(managedLink.activatedAt).toLocaleString()}</span>
                </div>
              )}
              {managedLink.lastVerify && !managedLink.lastVerify.ok && (
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="shrink-0 text-zinc-500">Last verify</span>
                  <span className="truncate text-right text-red-300">{managedLink.lastVerify.reason ?? "failed"}</span>
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
        ) : (
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="flex items-center gap-1.5 text-sm text-zinc-500">
              <Fingerprint className="h-4 w-4" aria-hidden /> Not linked yet.
            </p>
            <button
              type="button"
              disabled={linkLoading || enrollMutation.isPending || !status?.ready}
              onClick={() => enrollMutation.mutate()}
              className="inline-flex items-center gap-2 rounded-lg bg-sky-500 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {enrollMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Link2 className="h-4 w-4" aria-hidden />}
              {enrollMutation.isPending ? "Enrolling…" : "Enable connector"}
            </button>
          </div>
        )}
      </section>

      <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-zinc-200">
            <Users className="h-5 w-5 text-amber-400" aria-hidden />
            <h2 className="text-lg font-medium">Who can sign in</h2>
          </div>
          <button
            type="button"
            disabled={syncAccessMutation.isPending}
            onClick={() => syncAccessMutation.mutate()}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 transition-colors hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {syncAccessMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
            Sync
          </button>
        </div>
        <p className="mt-1 max-w-prose text-sm text-zinc-400">
          Only these users can pass Authentik for this site, and each gets a matching WordPress account — administrator,
          editor, or subscriber based on their RBAC grant. Grant a user a WordPress role scoped to this site in Access
          control and both update automatically.
        </p>
        {access && access.allowed.length > 0 ? (
          <ul className="mt-4 flex flex-wrap gap-2">
            {access.allowed.map((user) => (
              <li
                key={user}
                className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-950/50 px-2.5 py-0.5 text-xs text-zinc-200"
              >
                {user}
                {access.roles?.[user] && (
                  <span className="rounded-full border border-sky-500/30 bg-sky-500/15 px-1.5 py-px text-[10px] text-sky-300">
                    {access.roles[user]}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-zinc-500">No users are granted access to this site yet.</p>
        )}
        {access?.skippedNoEmail && access.skippedNoEmail.length > 0 && (
          <p className="mt-3 text-xs text-amber-400">
            No WordPress account for {access.skippedNoEmail.join(", ")} — add an email address to their user record
            first.
          </p>
        )}
      </section>

      <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-zinc-200">
            <CircleArrowUp className="h-5 w-5 text-teal-400" aria-hidden />
            <h2 className="text-lg font-medium">Plugin updates</h2>
          </div>
          <button
            type="button"
            disabled={updateAllMutation.isPending || pluginsUnavailable}
            onClick={() => updateAllMutation.mutate()}
            className="inline-flex items-center gap-2 rounded-lg bg-teal-500 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-teal-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {updateAllMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <CircleArrowUp className="h-4 w-4" aria-hidden />
            )}
            {updateAllMutation.isPending ? "Updating…" : "Update all plugins"}
          </button>
        </div>
        <p className="mt-1 max-w-prose text-sm text-zinc-400">
          Updates every installed plugin to its latest release. For larger updates, consider putting the site into
          maintenance mode first.
        </p>
        {updateAllMutation.data &&
          (updateAllMutation.data.updated.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-500">Everything is already up to date.</p>
          ) : (
            <ul className="mt-4 space-y-1.5">
              {updateAllMutation.data.updated.map((row) => {
                const ok = row.status.toLowerCase() === "updated";
                return (
                  <li
                    key={row.slug}
                    className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-1.5 text-sm"
                  >
                    <span className="truncate text-zinc-200">{row.slug}</span>
                    <span className="flex shrink-0 items-center gap-2">
                      {row.oldVersion && row.newVersion && (
                        <span className="text-xs text-zinc-500">
                          {row.oldVersion} → {row.newVersion}
                        </span>
                      )}
                      <span
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-[11px]",
                          ok
                            ? "border-green-500/30 bg-green-500/15 text-green-300"
                            : "border-red-500/30 bg-red-500/15 text-red-300",
                        )}
                      >
                        {row.status}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          ))}
      </section>

      <section className="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-zinc-200">
            <Puzzle className="h-5 w-5 text-sky-400" aria-hidden />
            <h2 className="text-lg font-medium">Plugins</h2>
          </div>
          <button
            type="button"
            disabled={!dirty || saveMutation.isPending || pluginsUnavailable}
            onClick={() => saveMutation.mutate()}
            className="inline-flex items-center gap-2 rounded-lg bg-sky-500 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saveMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CheckCircle2 className="h-4 w-4" aria-hidden />}
            {dirty ? "Apply changes" : "No changes"}
          </button>
        </div>

        {pluginsUnavailable ? (
          <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-300">
            {data?.installedError ?? "The site isn't ready yet — plugins can't be read until WordPress is running."}
          </div>
        ) : null}

        {isLoading ? (
          <div className="mt-4 flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading plugins…
          </div>
        ) : (
          <ul className="mt-4 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
            {(data?.catalog ?? []).map((plugin, index) => {
              const on = checked.has(plugin.slug);
              return (
                <motion.li
                  key={plugin.slug}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25, ease: EASE_OUT, delay: Math.min(index * 0.03, 0.15) }}
                >
                  <button
                    type="button"
                    onClick={() => toggle(plugin.slug)}
                    aria-pressed={on}
                    className={cn(
                      "flex w-full flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
                      on
                        ? "border-sky-500/50 bg-sky-500/10"
                        : "border-zinc-800 bg-zinc-950/40 hover:border-zinc-700",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium text-zinc-100">{plugin.name}</span>
                      <span
                        className={cn(
                          "h-4 w-4 shrink-0 rounded border",
                          on ? "border-sky-400 bg-sky-400" : "border-zinc-600",
                        )}
                        aria-hidden
                      />
                    </span>
                    <span className="text-xs text-zinc-400">{plugin.description}</span>
                    {plugin.sso && (
                      <span className="mt-1 inline-flex w-fit items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/15 px-2 py-0.5 text-[11px] text-violet-200">
                        Authentik SSO
                      </span>
                    )}
                  </button>
                </motion.li>
              );
            })}
          </ul>
        )}
      </section>

      <p className="mt-6 text-xs text-zinc-500">
        Database credentials and WordPress salts live in the vault under{" "}
        <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">secret/wordpress/{site}</code> — they are
        never shown here.
      </p>
    </div>
  );
}
