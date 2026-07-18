"use client";

import { useState, type ElementType } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion, AnimatePresence } from "framer-motion";
import {
  Globe,
  Plus,
  Loader2,
  ExternalLink,
  Trash2,
  ShieldCheck,
  CheckCircle2,
  CircleArrowUp,
  CircleDashed,
  Lock,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Select } from "@/components/ui/select";
import { isValidSiteName } from "../lib/naming";
import { ExternalSitesPanel } from "./external-sites-panel";
import { FLEET_DEMO_TABS, FleetDemoArea, type FleetTabId } from "./demo/fleet-tabs";

/** Top-level dashboard tabs: the real "Sites" surface plus the demo fleet views. */
type DashTab = "sites" | FleetTabId;

interface SiteSummary {
  site: string;
  host: string;
  ready: boolean;
  replicas: number;
  dnsWarning?: string;
  domain?: string;
  internal?: boolean;
  authMode?: AuthMode;
}

type AuthMode = "none" | "login" | "admin" | "full";

type PluginCategory = "sso" | "security" | "performance" | "seo" | "backup";

interface CatalogPlugin {
  slug: string;
  name: string;
  description: string;
  category: PluginCategory;
  recommended?: boolean;
  sso?: boolean;
}

interface WordpressConfig {
  domains: string[];
  defaultDomain: string;
  internalSubdomain: string;
  catalog: CatalogPlugin[];
}

/** Slice of the §5.1 connector-update sweep summary the header toast renders. */
interface ConnectorUpdateSummary {
  targetVersion: string;
  total: number;
  updated: number;
  failed: number;
  /** Enrolled links left for a later run because the per-run cap was hit. */
  deferred: number;
}

const AUTH_MODES: ReadonlyArray<{ value: AuthMode; label: string; helper: string }> = [
  {
    value: "none",
    label: "No Authentik — fully public",
    helper: "Anyone on the internet can reach the site.",
  },
  {
    value: "login",
    label: "Protect login only",
    helper:
      "Public site; only /wp-admin and /wp-login.php go through Authentik with auto-sign-in. Sensitive paths are NOT blocked.",
  },
  {
    value: "admin",
    label: "Protect admin & sensitive paths",
    helper:
      "Public site, but /wp-admin and login go through Authentik with auto-sign-in; xmlrpc and user-enumeration blocked.",
  },
  {
    value: "full",
    label: "Entire site behind Authentik",
    helper: "Nobody reaches the site without an Authentik login; auto-signs into WordPress.",
  },
];

const CATEGORY_ORDER: ReadonlyArray<PluginCategory> = ["sso", "security", "performance", "seo", "backup"];

const CATEGORY_LABELS: Record<PluginCategory, string> = {
  sso: "Single sign-on",
  security: "Security",
  performance: "Performance",
  seo: "SEO",
  backup: "Backup",
};

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

async function fetchSites(): Promise<SiteSummary[]> {
  const res = await fetch("/api/wordpress/sites");
  if (!res.ok) throw new Error("Failed to load sites");
  return ((await res.json()) as { sites: SiteSummary[] }).sites;
}

async function fetchConfig(): Promise<WordpressConfig> {
  const res = await fetch("/api/wordpress/config");
  if (!res.ok) throw new Error("Failed to load configuration");
  return (await res.json()) as WordpressConfig;
}

export function WordpressDashboard() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [domain, setDomain] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [internal, setInternal] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>("none");
  // §5.1 — the Connector (remote-management link) defaults ON for provisioned sites.
  const [connector, setConnector] = useState(true);
  const [selectedPlugins, setSelectedPlugins] = useState<string[]>([]);
  const [toDelete, setToDelete] = useState<string | null>(null);

  const { data: sites = [], isLoading } = useQuery({
    queryKey: ["wordpress-sites"],
    queryFn: fetchSites,
    refetchInterval: 8000,
  });

  const { data: config, isLoading: configLoading } = useQuery({
    queryKey: ["wordpress-config"],
    queryFn: fetchConfig,
  });

  // Derive the effective domain (no setState-in-effect): fall back to the config
  // default until the user explicitly picks one.
  const selectedDomain = domain || config?.defaultDomain || config?.domains?.[0] || "";

  const ssoPlugin = config?.catalog.find((plugin) => plugin.sso);
  const trimmedSubdomain = subdomain.trim();
  const subdomainValid = trimmedSubdomain === "" || isValidSiteName(trimmedSubdomain);
  const hasDomains = (config?.domains.length ?? 0) > 0;

  // SSO is wired automatically whenever Authentik protection is enabled, so it
  // is never sent explicitly in that case.
  const effectivePlugins = selectedPlugins.filter(
    (slug) => !(authMode !== "none" && ssoPlugin?.slug === slug),
  );

  const previewHost = [
    trimmedSubdomain || null,
    internal ? config?.internalSubdomain : null,
    selectedDomain || null,
  ]
    .filter(Boolean)
    .join(".");

  const resetForm = () => {
    setSubdomain("");
    setInternal(false);
    setAuthMode("none");
    setConnector(true);
    setSelectedPlugins([]);
    setDomain(config?.defaultDomain || config?.domains[0] || "");
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      const body = {
        name: trimmedSubdomain || undefined,
        domain: selectedDomain,
        internal: internal || undefined,
        authMode,
        plugins: effectivePlugins.length > 0 ? effectivePlugins : undefined,
        connector,
      };
      const res = await fetch("/api/wordpress/sites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Create failed");
    },
    onSuccess: () => {
      toast.success(`Provisioning ${previewHost || selectedDomain}`);
      resetForm();
      setCreating(false);
      void queryClient.invalidateQueries({ queryKey: ["wordpress-sites"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (site: string) => {
      const res = await fetch(`/api/wordpress/sites/${site}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      toast.success("Site deleted");
      void queryClient.invalidateQueries({ queryKey: ["wordpress-sites"] });
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => setToDelete(null),
  });

  // §5.1 fleet maintenance — reinstall the bundled Connector on every enrolled
  // managed link in one push (server enforces namespace-wide wordpress:admin).
  const updateConnectorsMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/wordpress/connector-update-sweep", { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Connector update failed");
      return ((await res.json()) as { summary: ConnectorUpdateSummary }).summary;
    },
    onSuccess: (summary) => {
      const deferredTail = summary.deferred > 0 ? ` — ${summary.deferred} deferred, run again to continue` : "";
      if (summary.total === 0) {
        toast.success("No enrolled connectors to update");
      } else if (summary.failed === 0) {
        toast.success(`Updated ${summary.updated} connector${summary.updated === 1 ? "" : "s"} to ${summary.targetVersion}${deferredTail}`);
      } else {
        toast.error(`${summary.updated}/${summary.total} connectors updated — ${summary.failed} failed (check each site's connector tab)${deferredTail}`);
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const togglePlugin = (slug: string) =>
    setSelectedPlugins((prev) =>
      prev.includes(slug) ? prev.filter((value) => value !== slug) : [...prev, slug],
    );

  const canSubmit =
    !configLoading && hasDomains && Boolean(selectedDomain) && subdomainValid && !createMutation.isPending;

  const [tab, setTab] = useState<DashTab>("sites");
  const dashTabs: ReadonlyArray<{ id: DashTab; label: string; icon: ElementType; demo: boolean }> = [
    { id: "sites", label: "Sites", icon: Globe, demo: false },
    ...FLEET_DEMO_TABS.map((entry) => ({ id: entry.id, label: entry.label, icon: entry.icon, demo: true })),
  ];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2.5 text-zinc-100">
            <Globe className="h-6 w-6 text-sky-400" aria-hidden />
            <h1 className="text-2xl font-semibold tracking-tight">WordPress Manager</h1>
          </div>
          <p className="max-w-prose text-sm text-zinc-400">
            Provision hardened WordPress sites — secrets, database, DNS, TLS and Authentik SSO handled for you.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={updateConnectorsMutation.isPending}
            onClick={() => updateConnectorsMutation.mutate()}
            title="Reinstall the bundled Connector plugin on every enrolled in-cluster site"
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {updateConnectorsMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <CircleArrowUp className="h-4 w-4" aria-hidden />
            )}
            {updateConnectorsMutation.isPending ? "Updating…" : "Update connectors"}
          </button>
          <button
            type="button"
            onClick={() => {
              setTab("sites");
              setCreating((open) => !open);
            }}
            className="inline-flex items-center gap-2 rounded-lg bg-sky-500 px-3.5 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          >
            <Plus className="h-4 w-4" aria-hidden /> New site
          </button>
        </div>
      </header>

      <nav aria-label="WordPress views" className="mt-6 flex gap-1 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800">
        {dashTabs.map((entry) => {
          const on = entry.id === tab;
          const Icon = entry.icon;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => setTab(entry.id)}
              aria-current={on ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 py-2 text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400",
                on
                  ? "border-sky-500 font-medium text-zinc-900 dark:text-zinc-100"
                  : "border-transparent text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {entry.label}
              {entry.demo && (
                <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                  Demo
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {tab === "sites" && (
        <>
      <AnimatePresence initial={false}>
        {creating && (
          <motion.form
            key="create"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.28, ease: EASE_OUT }}
            onSubmit={(event) => {
              event.preventDefault();
              if (canSubmit) createMutation.mutate();
            }}
            className="overflow-hidden"
          >
            <div className="mt-6 space-y-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-5">
              {configLoading ? (
                <div className="flex items-center gap-2 text-sm text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading configuration…
                </div>
              ) : !hasDomains ? (
                <p className="text-sm text-amber-400">
                  No domains configured. Add a domain before creating a WordPress site.
                </p>
              ) : (
                <>
                  {/* Domain + subdomain */}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label className="block text-sm font-medium text-zinc-300" htmlFor="wp-domain">
                        Domain
                      </label>
                      <p className="mt-1 text-xs text-zinc-500">The base domain the site is served under.</p>
                      <Select
                        id="wp-domain"
                        className="mt-3"
                        value={selectedDomain}
                        onChange={(event) => setDomain(event.target.value)}
                      >
                        {config?.domains.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </Select>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-zinc-300" htmlFor="wp-subdomain">
                        Subdomain
                      </label>
                      <p className="mt-1 text-xs text-zinc-500">Leave blank to use the root domain.</p>
                      <input
                        id="wp-subdomain"
                        value={subdomain}
                        onChange={(event) => setSubdomain(event.target.value.toLowerCase())}
                        placeholder="blog"
                        autoFocus
                        aria-invalid={!subdomainValid}
                        className="mt-3 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                      />
                      {trimmedSubdomain !== "" && !subdomainValid && (
                        <p className="mt-2 text-xs text-amber-400">
                          3–32 chars, lowercase letters, digits and hyphens, not starting or ending with a hyphen.
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Internal toggle */}
                  <label className="flex items-start gap-2.5 text-sm text-zinc-300">
                    <input
                      type="checkbox"
                      checked={internal}
                      onChange={(event) => setInternal(event.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-950 text-sky-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                    />
                    <span>
                      Internal only — {(trimmedSubdomain || "<name>")}.{config?.internalSubdomain}.{domain || "<domain>"}, reachable only inside the network
                    </span>
                  </label>

                  {/* InfraWeaver Connector (§5.1 — default ON) */}
                  <label className="flex items-start gap-2.5 text-sm text-zinc-300">
                    <input
                      type="checkbox"
                      checked={connector}
                      onChange={(event) => setConnector(event.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-950 text-sky-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                    />
                    <span>
                      Install InfraWeaver Connector — links the site over the signed IWSL management channel once it
                      is running (can be changed later from site settings)
                    </span>
                  </label>

                  {/* Authentik protection */}
                  <fieldset>
                    <legend className="flex items-center gap-2 text-sm font-medium text-zinc-300">
                      <ShieldCheck className="h-4 w-4 text-sky-400" aria-hidden /> Authentik protection
                    </legend>
                    <div className="mt-3 grid gap-2.5 sm:grid-cols-3">
                      {AUTH_MODES.map((mode) => {
                        const active = authMode === mode.value;
                        return (
                          <label
                            key={mode.value}
                            className={cn(
                              "flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-sm transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-sky-400",
                              active
                                ? "border-sky-500/60 bg-sky-500/10 text-zinc-100"
                                : "border-zinc-700 bg-zinc-950 text-zinc-300 hover:border-zinc-600",
                            )}
                          >
                            <span className="flex items-center gap-2 font-medium">
                              <input
                                type="radio"
                                name="wp-auth-mode"
                                value={mode.value}
                                checked={active}
                                onChange={() => setAuthMode(mode.value)}
                                className="h-4 w-4 border-zinc-600 bg-zinc-950 text-sky-500 focus:outline-none"
                              />
                              {mode.label}
                            </span>
                            <span className="text-xs text-zinc-500">{mode.helper}</span>
                          </label>
                        );
                      })}
                    </div>
                  </fieldset>

                  {/* Plugins */}
                  {config && config.catalog.length > 0 && (
                    <div>
                      <p className="text-sm font-medium text-zinc-300">Plugins</p>
                      <p className="mt-1 text-xs text-zinc-500">
                        Optional add-ons installed and configured automatically.
                      </p>
                      <div className="mt-3 space-y-4">
                        {CATEGORY_ORDER.map((category) => {
                          const plugins = config.catalog.filter((plugin) => plugin.category === category);
                          if (plugins.length === 0) return null;
                          return (
                            <div key={category}>
                              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                                {CATEGORY_LABELS[category]}
                              </p>
                              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                                {plugins.map((plugin) => {
                                  const ssoManaged = Boolean(plugin.sso) && authMode !== "none";
                                  const checked = ssoManaged || selectedPlugins.includes(plugin.slug);
                                  return (
                                    <label
                                      key={plugin.slug}
                                      className={cn(
                                        "flex items-start gap-2.5 rounded-lg border p-3 text-sm transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-sky-400",
                                        ssoManaged
                                          ? "cursor-not-allowed border-zinc-800 bg-zinc-900/40"
                                          : "cursor-pointer border-zinc-700 bg-zinc-950 hover:border-zinc-600",
                                      )}
                                    >
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        disabled={ssoManaged}
                                        onChange={() => togglePlugin(plugin.slug)}
                                        className="mt-0.5 h-4 w-4 rounded border-zinc-600 bg-zinc-950 text-sky-500 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
                                      />
                                      <span className="min-w-0">
                                        <span className="flex flex-wrap items-center gap-1.5 font-medium text-zinc-200">
                                          {plugin.name}
                                          {plugin.recommended && (
                                            <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-300">
                                              <Sparkles className="h-2.5 w-2.5" aria-hidden /> Recommended
                                            </span>
                                          )}
                                          {ssoManaged && (
                                            <span className="inline-flex items-center gap-1 rounded-full border border-zinc-600/40 bg-zinc-700/30 px-1.5 py-0.5 text-[10px] font-medium text-zinc-300">
                                              <Lock className="h-2.5 w-2.5" aria-hidden /> Auto-managed
                                            </span>
                                          )}
                                        </span>
                                        <span className="mt-0.5 block text-xs text-zinc-500">{plugin.description}</span>
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Live host preview + submit */}
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 pt-4">
                    <p className="font-mono text-sm text-sky-300" aria-live="polite">
                      → https://{previewHost || domain || "…"}
                    </p>
                    <button
                      type="submit"
                      disabled={!canSubmit}
                      className="inline-flex items-center gap-2 rounded-lg bg-sky-500 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {createMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                      ) : (
                        <Plus className="h-4 w-4" aria-hidden />
                      )}
                      Provision
                    </button>
                  </div>
                </>
              )}
            </div>
          </motion.form>
        )}
      </AnimatePresence>

      <section className="mt-8">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading sites…
          </div>
        ) : sites.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 px-6 py-16 text-center">
            <Globe className="mx-auto h-8 w-8 text-zinc-600" aria-hidden />
            <p className="mt-3 text-sm font-medium text-zinc-300">No WordPress sites yet</p>
            <p className="mt-1 text-sm text-zinc-500">Create one above — everything is provisioned automatically.</p>
          </div>
        ) : (
          <ul className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
            {sites.map((site, index) => (
              <motion.li
                key={site.site}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: EASE_OUT, delay: Math.min(index * 0.04, 0.2) }}
                className="group flex flex-col justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 transition-colors hover:border-zinc-700"
              >
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/wordpress/${encodeURIComponent(site.site)}`} className="font-medium text-zinc-100 hover:text-sky-300">
                      {site.site}
                    </Link>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                        site.ready
                          ? "border-green-500/30 bg-green-500/15 text-green-300"
                          : "border-amber-500/30 bg-amber-500/15 text-amber-300",
                      )}
                    >
                      {site.ready ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : <CircleDashed className="h-3 w-3 animate-pulse" aria-hidden />}
                      {site.ready ? "Ready" : "Starting"}
                    </span>
                  </div>
                  <a
                    href={`https://${site.host}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-sm text-zinc-400 hover:text-zinc-200"
                  >
                    {site.host} <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                </div>
                <div className="mt-4 flex items-center justify-between">
                  <Link
                    href={`/wordpress/${encodeURIComponent(site.site)}`}
                    className="inline-flex items-center gap-1.5 text-sm text-sky-400 hover:text-sky-300"
                  >
                    <ShieldCheck className="h-4 w-4" aria-hidden /> Manage
                  </Link>
                  <button
                    type="button"
                    onClick={() => setToDelete(site.site)}
                    className="rounded-md p-1.5 text-zinc-500 opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-400 focus-visible:opacity-100 group-hover:opacity-100"
                    aria-label={`Delete ${site.site}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </button>
                </div>
              </motion.li>
            ))}
          </ul>
        )}
      </section>

      <ExternalSitesPanel />
        </>
      )}

      {tab !== "sites" && (
        <div className="mt-6">
          <FleetDemoArea tab={tab} />
        </div>
      )}

      <ConfirmDialog
        open={toDelete !== null}
        title={`Delete ${toDelete ?? "site"}?`}
        description="This removes the WordPress and database workloads, their volumes, the DNS record and every secret in the vault. This cannot be undone."
        confirmText="Delete site"
        danger
        onConfirm={() => {
          if (toDelete) deleteMutation.mutate(toDelete);
        }}
        onCancel={() => setToDelete(null)}
      />
    </div>
  );
}
