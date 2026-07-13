"use client";

// Access Studio — the account & credential board for a single person's Jellyfin
// login, the one service SSO can't fully cover (native/TV apps need a local
// account with a generated password).
//
// Rights ASSIGNMENT — granting or revoking Jellyfin, folders, or any resource —
// now lives in the unified /rbac page. What stays here is user-lifecycle
// credential management: reveal the generated password, reset it, and reconcile
// every account against RBAC. Every mutation still routes through the same
// audited, privilege-ceiling-checked hooks the retired grant panels used, so
// nothing about the backend contract changes.

import { useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Check,
  Clapperboard,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  Shield,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import type { PlatformUser } from "@/hooks/use-users-config";
import {
  useJellyfinAccess,
  useResetJellyfinCredential,
  useRevealJellyfinCredential,
  useSyncJellyfinUsers,
  type JellyfinCredential,
} from "@/hooks/use-jellyfin-access";

interface Props {
  user: PlatformUser | null;
  isAdmin: boolean;
}

/** The revealed password, shown once behind an explicit click. */
function CredentialCard({ credential, onHide }: { credential: JellyfinCredential; onHide: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 rounded-xl border border-purple-500/20 bg-purple-500/5 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-slate-700 dark:text-slate-300">Jellyfin sign-in</p>
        <button type="button" onClick={onHide} className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-gray-900 dark:hover:text-white">
          <EyeOff className="h-3 w-3" /> Hide
        </button>
      </div>
      <dl className="mt-1.5 space-y-1 text-[11px]">
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-slate-500">Server</dt>
          <dd className="truncate font-mono text-slate-700 dark:text-slate-300">{credential.launchUrl}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-16 shrink-0 text-slate-500">Username</dt>
          <dd className="font-mono text-slate-700 dark:text-slate-300">{credential.username}</dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="w-16 shrink-0 text-slate-500">Password</dt>
          <dd className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-slate-700 dark:text-slate-300">{credential.password}</span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(credential.password);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="shrink-0 rounded p-1 text-slate-500 transition-colors hover:text-gray-900 dark:hover:text-white"
              title="Copy password"
            >
              {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
            </button>
          </dd>
        </div>
      </dl>
      <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
        Use this in the Jellyfin app on a TV or phone, where SSO does not work. Signing in on the web can still use SSO.
      </p>
    </div>
  );
}

/** Small state dot + word, so the account's status is legible at a glance. */
function StatusDot({ tone, label }: { tone: "on" | "off" | "admin"; label: string }) {
  const color =
    tone === "on" ? "bg-emerald-500" :
    tone === "admin" ? "bg-purple-500" :
    "bg-slate-400/60";
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
      <span className={cn("h-2 w-2 rounded-full", color, tone !== "off" && "shadow-[0_0_0_3px] shadow-current/10")} />
      {label}
    </span>
  );
}

export function UserAccessStudio({ user, isAdmin }: Props) {
  const [credential, setCredential] = useState<JellyfinCredential | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const jellyfinQuery = useJellyfinAccess(Boolean(user));
  const reveal = useRevealJellyfinCredential();
  const resetCred = useResetJellyfinCredential();
  const sync = useSyncJellyfinUsers();

  const jellyfinGrants = useMemo(
    () =>
      (jellyfinQuery.data?.grants ?? []).filter(
        (grant) => grant.principalType === "user" && grant.principalId === user?.username,
      ),
    [jellyfinQuery.data, user?.username],
  );

  if (!user) return null;

  const canManage = (jellyfinQuery.data?.canManage ?? false) && isAdmin;
  const launchUrl = jellyfinQuery.data?.launchUrl;
  const jellyfinGrant = jellyfinGrants[0];
  const jellyfinAdmin = jellyfinGrant?.roleId === "jellyfin-admin";

  function resetBanners() {
    setError(null);
    setNotice(null);
    setWarning(null);
  }

  async function submitRevealJellyfin() {
    resetBanners();
    try {
      setCredential(await reveal.mutateAsync(user!.username));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reveal credential");
    }
  }

  async function submitResetJellyfin() {
    resetBanners();
    if (!window.confirm(`Reset ${user!.username}'s Jellyfin password? Their existing app logins stop working until they sign in with the new one.`)) {
      return;
    }
    try {
      setCredential(await resetCred.mutateAsync(user!.username));
      setNotice(`New Jellyfin password generated for ${user!.username}. Reveal it below and hand it off.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reset credential");
    }
  }

  async function submitSync() {
    resetBanners();
    try {
      const result = await sync.mutateAsync();
      const parts = [
        result.created.length ? `${result.created.length} created` : "",
        result.enabled.length ? `${result.enabled.length} re-enabled` : "",
        result.roleChanged.length ? `${result.roleChanged.length} role changed` : "",
        result.disabled.length ? `${result.disabled.length} disabled` : "",
      ].filter(Boolean);
      setNotice(parts.length ? `Jellyfin accounts reconciled: ${parts.join(", ")}.` : "Jellyfin accounts already match RBAC.");
      const warnings: string[] = [];
      if (result.pendingHandoff.length) {
        warnings.push(`Credential never handed off to ${result.pendingHandoff.join(", ")}. Reveal it to them.`);
      }
      if (result.adopted.length) {
        warnings.push(`Adopted ${result.adopted.join(", ")} back into management — reset their password to hand off a working login.`);
      }
      setWarning(warnings.length ? warnings.join(" ") : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reconcile Jellyfin accounts");
    }
  }

  const initials = (user.name || user.username).slice(0, 2).toUpperCase();

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="relative overflow-hidden rounded-3xl border border-gray-200 bg-white shadow-sm dark:border-[#242424] dark:bg-[#0b0b0b]"
    >
      {/* Hero band */}
      <div className="relative overflow-hidden border-b border-gray-200 px-5 py-4 dark:border-[#1c1c1c]">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#AA5CC3]/10 to-[#00A4DC]/10" />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-500/15 text-base font-bold text-indigo-600 ring-1 ring-inset ring-indigo-500/30 dark:text-indigo-300">
              {initials}
            </span>
            <div>
              <h3 className="text-base font-semibold text-gray-900 dark:text-white">
                Jellyfin account · {user.name || user.username}
              </h3>
              <p className="text-xs text-slate-500">
                Reveal, reset, and reconcile the local sign-in for TV &amp; mobile apps.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full border border-gray-200 bg-white/60 px-3 py-1 text-xs font-medium text-slate-600 backdrop-blur dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
              {jellyfinGrant ? (jellyfinAdmin ? "Administrator" : "Account active") : "No account"}
            </span>
            {canManage ? (
              <button
                type="button"
                onClick={() => void submitSync()}
                disabled={sync.isPending}
                title="Reconcile every Jellyfin account against RBAC"
                className="rounded-lg border border-gray-200 p-1.5 text-slate-500 transition-colors hover:text-gray-900 disabled:opacity-40 dark:border-white/10 dark:hover:text-white"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", sync.isPending && "animate-spin")} />
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="p-5">
        <div className="group relative overflow-hidden rounded-2xl border border-gray-200 bg-white p-4 transition-shadow hover:shadow-lg dark:border-[#2a2a2a] dark:bg-[#0f0f0f]">
          <div className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-gradient-to-br from-[#AA5CC3] to-[#00A4DC] opacity-20 blur-3xl transition-opacity group-hover:opacity-40" />
          <div className="relative mb-4 flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#AA5CC3] to-[#00A4DC] text-white shadow-sm">
                <Clapperboard className="h-5 w-5" />
              </span>
              <div>
                <p className="text-sm font-semibold text-gray-900 dark:text-white">Jellyfin</p>
                <p className="text-[11px] text-slate-500">Media on TV &amp; mobile</p>
                <div className="mt-1">
                  {jellyfinQuery.isLoading ? (
                    <StatusDot tone="off" label="Loading…" />
                  ) : jellyfinGrant ? (
                    <StatusDot tone={jellyfinAdmin ? "admin" : "on"} label={jellyfinAdmin ? "Administrator" : "Active account"} />
                  ) : (
                    <StatusDot tone="off" label="No account" />
                  )}
                </div>
              </div>
            </div>
            {jellyfinGrant && canManage ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => (credential ? setCredential(null) : void submitRevealJellyfin())}
                  disabled={reveal.isPending}
                  title="Reveal username & password for the Jellyfin app"
                  className="rounded-lg border border-gray-200 p-1.5 text-slate-500 transition-colors hover:border-purple-500/40 hover:text-purple-500 disabled:opacity-40 dark:border-white/10"
                >
                  {reveal.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : credential ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => void submitResetJellyfin()}
                  disabled={resetCred.isPending}
                  title="Reset the Jellyfin password"
                  className="rounded-lg border border-gray-200 p-1.5 text-slate-500 transition-colors hover:border-amber-500/40 hover:text-amber-500 disabled:opacity-40 dark:border-white/10"
                >
                  {resetCred.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
                </button>
              </div>
            ) : null}
          </div>

          <div className="relative">
            {jellyfinGrant ? (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                  <span className="inline-flex items-center gap-1">
                    {jellyfinAdmin ? <Shield className="h-3 w-3 text-purple-500" /> : <UserRound className="h-3 w-3" />}
                    {jellyfinAdmin ? "Admin" : "User"}
                  </span>
                  <span>Granted by {jellyfinGrant.grantedBy}</span>
                  {jellyfinGrant.expiresAt ? (
                    <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                      <Clock className="h-3 w-3" /> expires {formatDate(jellyfinGrant.expiresAt)}
                    </span>
                  ) : null}
                </div>
                {launchUrl ? (
                  <a
                    href={launchUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-purple-600 hover:underline dark:text-purple-300"
                  >
                    <ExternalLink className="h-3 w-3" /> Open Jellyfin
                  </a>
                ) : null}
                {credential ? <CredentialCard credential={credential} onHide={() => setCredential(null)} /> : null}
              </div>
            ) : (
              <div className="space-y-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 dark:border-white/10 dark:bg-white/5">
                <p className="text-xs text-slate-500">
                  No Jellyfin account. Grant one from the RBAC page — this card then manages its sign-in.
                </p>
                <Link
                  href="/rbac"
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-purple-600 hover:underline dark:text-purple-300"
                >
                  <ShieldCheck className="h-3 w-3" /> Assign access in RBAC
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Banners + footer note */}
      {(error || notice || warning) ? (
        <div className="space-y-1 px-5 pb-2">
          {error ? <p className="text-sm text-red-500">{error}</p> : null}
          {notice ? <p className="text-sm text-emerald-600 dark:text-emerald-300">{notice}</p> : null}
          {warning ? <p className="text-sm text-amber-600 dark:text-amber-400">{warning}</p> : null}
        </div>
      ) : null}

      <div className="flex items-start gap-2 border-t border-gray-200 px-5 py-3 text-[11px] leading-snug text-slate-500 dark:border-[#1c1c1c]">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
        <span>
          The Jellyfin password is generated, stored encrypted, and never emailed. Reveal it to hand it off, or reset it to
          recover a forgotten login. Every action is audited and honours the RBAC privilege ceiling.
        </span>
      </div>
    </motion.section>
  );
}
