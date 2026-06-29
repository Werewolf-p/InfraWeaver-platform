"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Loader2,
  KeyRound,
  Puzzle,
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  Globe,
  Lock,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";

type AuthMode = "none" | "admin" | "full";

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

const AUTH_MODE_LABEL: Record<AuthMode, string> = {
  none: "Public",
  admin: "Admin paths protected",
  full: "Behind Authentik",
};

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

export function SiteDetailView({ site }: { site: string }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [issuer, setIssuer] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["wordpress-plugins", site],
    queryFn: () => fetchPlugins(site),
  });

  const { data: status } = useQuery({
    queryKey: ["wordpress-site-status", site],
    queryFn: () => fetchSiteStatus(site),
    refetchInterval: 8000,
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
