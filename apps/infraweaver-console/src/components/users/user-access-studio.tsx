"use client";

// Access Studio — one board to set a single person's access to the platform's
// two headline services: Jellyfin (media) and Nextcloud folders (files).
//
// Deliberately a COMPOSITION, not a rewrite. Jellyfin and folder access remain
// two independent grants (see the sibling panels this replaces in the user
// detail); this only unifies where an admin sets them, so the act of "give this
// person access" is one obvious, visual place instead of three panels buried
// below the roster. Every mutation routes through the same hooks — and therefore
// the same audited, privilege-ceiling-checked `grantRoleAssignment` — the old
// panels used, so nothing about the backend contract changes.

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useQuery } from "@tanstack/react-query";
import {
  Clapperboard,
  Clock,
  Eye,
  EyeOff,
  ExternalLink,
  Folder,
  FolderTree,
  KeyRound,
  Loader2,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Shield,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import { scopeLabel, type RoleAssignment } from "@/lib/rbac";
import type { PlatformUser } from "@/hooks/use-users-config";
import {
  useGrantJellyfinAccess,
  useJellyfinAccess,
  useResetJellyfinCredential,
  useRevealJellyfinCredential,
  useRevokeJellyfinAccess,
  useSyncJellyfinUsers,
  type JellyfinCredential,
  type JellyfinRoleId,
} from "@/hooks/use-jellyfin-access";
import { useRevokeStorageAccess } from "@/hooks/use-storage-access";
import { CredentialCard, GrantJellyfinSheet } from "./user-jellyfin-access-panel";
import { GrantFolderSheet } from "./user-storage-access-panel";

interface Props {
  user: PlatformUser | null;
  isAdmin: boolean;
}

/** A folder grant reads read-write for a contributor, read-only otherwise. */
function folderAccessLabel(roleId: string): { label: string; rw: boolean } {
  return roleId === "storage-contributor" ? { label: "RW", rw: true } : { label: "RO", rw: false };
}

function isStorageScope(scope: string): boolean {
  return scope === "/nas" || scope.startsWith("/nas/");
}

/** Small state dot + word, so a service's status is legible at a glance. */
function StatusDot({ tone, label }: { tone: "on" | "off" | "admin" | "warn"; label: string }) {
  const color =
    tone === "on" ? "bg-emerald-500" :
    tone === "admin" ? "bg-purple-500" :
    tone === "warn" ? "bg-amber-500" :
    "bg-slate-400/60";
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
      <span className={cn("h-2 w-2 rounded-full", color, tone !== "off" && "shadow-[0_0_0_3px] shadow-current/10")} />
      {label}
    </span>
  );
}

/** The frosted shell every service tile shares — a branded corner glow + header. */
function ServiceTile({
  icon: Icon,
  title,
  subtitle,
  accentFrom,
  accentTo,
  status,
  action,
  children,
}: {
  icon: typeof Clapperboard;
  title: string;
  subtitle: string;
  accentFrom: string;
  accentTo: string;
  status: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-gray-200 bg-white p-4 transition-shadow hover:shadow-lg dark:border-[#2a2a2a] dark:bg-[#0f0f0f]">
      {/* branded corner glow */}
      <div className={cn("pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full opacity-20 blur-3xl transition-opacity group-hover:opacity-40 bg-gradient-to-br", accentFrom, accentTo)} />
      <div className="relative mb-4 flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm", accentFrom, accentTo)}>
            <Icon className="h-5 w-5" />
          </span>
          <div>
            <p className="text-sm font-semibold text-gray-900 dark:text-white">{title}</p>
            <p className="text-[11px] text-slate-500">{subtitle}</p>
            <div className="mt-1">{status}</div>
          </div>
        </div>
        {action}
      </div>
      <div className="relative">{children}</div>
    </div>
  );
}

export function UserAccessStudio({ user, isAdmin }: Props) {
  const [grantingJellyfin, setGrantingJellyfin] = useState(false);
  const [grantingFolder, setGrantingFolder] = useState(false);
  const [credential, setCredential] = useState<JellyfinCredential | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  const jellyfinQuery = useJellyfinAccess(Boolean(user));
  const grantJellyfin = useGrantJellyfinAccess();
  const revokeJellyfin = useRevokeJellyfinAccess();
  const reveal = useRevealJellyfinCredential();
  const resetCred = useResetJellyfinCredential();
  const sync = useSyncJellyfinUsers();
  const revokeStorage = useRevokeStorageAccess();

  const assignmentsQuery = useQuery<{ role_assignments: RoleAssignment[] }>({
    queryKey: ["users-config", user?.username, "rbac"],
    queryFn: async () => {
      const res = await fetch(`/api/users-config/${user?.username}/rbac`);
      if (!res.ok) throw new Error("Failed to load role assignments");
      return (await res.json()) as { role_assignments: RoleAssignment[] };
    },
    enabled: Boolean(user?.username),
  });

  const jellyfinGrants = useMemo(
    () =>
      (jellyfinQuery.data?.grants ?? []).filter(
        (grant) => grant.principalType === "user" && grant.principalId === user?.username,
      ),
    [jellyfinQuery.data, user?.username],
  );
  const folderGrants = useMemo(
    () => (assignmentsQuery.data?.role_assignments ?? []).filter((a) => isStorageScope(a.scope)),
    [assignmentsQuery.data],
  );

  if (!user) return null;

  const canManage = (jellyfinQuery.data?.canManage ?? false) && isAdmin;
  const launchUrl = jellyfinQuery.data?.launchUrl;
  const jellyfinGrant = jellyfinGrants[0];
  const jellyfinAdmin = jellyfinGrant?.roleId === "jellyfin-admin";
  const grantCount = jellyfinGrants.length + folderGrants.length;

  function resetBanners() {
    setError(null);
    setNotice(null);
    setWarning(null);
  }

  async function quickGrantJellyfin(roleId: JellyfinRoleId) {
    resetBanners();
    setCredential(null);
    try {
      await grantJellyfin.mutateAsync({ roleId, principalType: "user", principal: user!.username });
      setNotice(`Jellyfin account provisioning for ${user!.name || user!.username}. Reveal the password below to hand it off.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to grant Jellyfin access");
    }
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

  async function submitRevokeJellyfin() {
    resetBanners();
    setCredential(null);
    try {
      await revokeJellyfin.mutateAsync({ assignmentId: jellyfinGrant!.id, principalType: "user", principal: user!.username });
      setNotice(`Jellyfin account for ${user!.username} will be disabled — watch history is kept.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke Jellyfin access");
    }
  }

  async function submitRevokeFolder(assignment: RoleAssignment) {
    resetBanners();
    try {
      await revokeStorage.mutateAsync({ assignmentId: assignment.id, principalType: "user", principal: user!.username });
      await assignmentsQuery.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke folder access");
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
      {/* Hero band — makes the studio the unmissable answer to "where do I set access". */}
      <div className="relative overflow-hidden border-b border-gray-200 px-5 py-4 dark:border-[#1c1c1c]">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#AA5CC3]/10 to-[#0082C9]/10" />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-500/15 text-base font-bold text-indigo-600 ring-1 ring-inset ring-indigo-500/30 dark:text-indigo-300">
              {initials}
            </span>
            <div>
              <h3 className="text-base font-semibold text-gray-900 dark:text-white">
                Access · {user.name || user.username}
              </h3>
              <p className="text-xs text-slate-500">
                Set what {user.name || user.username} can reach — media and files, in one place.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full border border-gray-200 bg-white/60 px-3 py-1 text-xs font-medium text-slate-600 backdrop-blur dark:border-white/10 dark:bg-white/5 dark:text-slate-300">
              {grantCount === 0 ? "No access yet" : `${grantCount} grant${grantCount === 1 ? "" : "s"} active`}
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

      <div className="grid grid-cols-1 gap-4 p-5 lg:grid-cols-2">
        {/* ── Jellyfin ─────────────────────────────────────────────── */}
        <ServiceTile
          icon={Clapperboard}
          title="Jellyfin"
          subtitle="Media on TV & mobile"
          accentFrom="from-[#AA5CC3]"
          accentTo="to-[#00A4DC]"
          status={
            jellyfinQuery.isLoading ? (
              <StatusDot tone="off" label="Loading…" />
            ) : jellyfinGrant ? (
              <StatusDot tone={jellyfinAdmin ? "admin" : "on"} label={jellyfinAdmin ? "Administrator" : "Active account"} />
            ) : (
              <StatusDot tone="off" label="No account" />
            )
          }
          action={
            jellyfinGrant && canManage ? (
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
                <button
                  type="button"
                  onClick={() => void submitRevokeJellyfin()}
                  disabled={revokeJellyfin.isPending}
                  title="Revoke Jellyfin access (disables the account, keeps history)"
                  className="rounded-lg border border-gray-200 p-1.5 text-slate-500 transition-colors hover:border-red-500/40 hover:text-red-500 disabled:opacity-40 dark:border-white/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : null
          }
        >
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
          ) : canManage ? (
            <div className="space-y-2">
              <p className="text-xs text-slate-500">Grant a local account so TV and mobile apps can sign in — SSO covers only the web.</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void quickGrantJellyfin("jellyfin-user")}
                  disabled={grantJellyfin.isPending}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-purple-500/30 bg-purple-500/15 px-3 py-2 text-xs font-semibold text-purple-700 transition-colors hover:bg-purple-500/25 disabled:opacity-50 dark:text-purple-200"
                >
                  {grantJellyfin.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserRound className="h-3.5 w-3.5" />}
                  Grant User
                </button>
                <button
                  type="button"
                  onClick={() => void quickGrantJellyfin("jellyfin-admin")}
                  disabled={grantJellyfin.isPending}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-gray-100 px-3 py-2 text-xs font-semibold text-slate-600 transition-colors hover:border-purple-500/40 hover:text-purple-600 disabled:opacity-50 dark:border-white/10 dark:bg-white/5 dark:text-slate-300"
                >
                  <Shield className="h-3.5 w-3.5" />
                  Grant Admin
                </button>
                <button
                  type="button"
                  onClick={() => setGrantingJellyfin(true)}
                  className="inline-flex items-center gap-1.5 rounded-xl px-2 py-2 text-xs font-medium text-slate-500 transition-colors hover:text-gray-900 dark:hover:text-white"
                >
                  <Clock className="h-3.5 w-3.5" /> with expiry…
                </button>
              </div>
            </div>
          ) : (
            <p className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-xs text-slate-500 dark:border-white/10 dark:bg-white/5">
              No Jellyfin account.
            </p>
          )}
        </ServiceTile>

        {/* ── Nextcloud folders ────────────────────────────────────── */}
        <ServiceTile
          icon={FolderTree}
          title="Nextcloud folders"
          subtitle="Files & shares"
          accentFrom="from-[#0082C9]"
          accentTo="to-[#0078D4]"
          status={
            assignmentsQuery.isLoading ? (
              <StatusDot tone="off" label="Loading…" />
            ) : folderGrants.length ? (
              <StatusDot tone="on" label={`${folderGrants.length} folder${folderGrants.length === 1 ? "" : "s"}`} />
            ) : (
              <StatusDot tone="off" label="No folders" />
            )
          }
          action={
            canManage ? (
              <button
                type="button"
                onClick={() => setGrantingFolder(true)}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[#0078D4]/30 bg-[#0078D4]/10 px-2.5 py-1.5 text-xs font-medium text-[#0078D4] transition-colors hover:bg-[#0078D4]/20 dark:text-[#7cb9ff]"
              >
                <Plus className="h-3.5 w-3.5" />
                Grant folder
              </button>
            ) : null
          }
        >
          {folderGrants.length === 0 ? (
            <p className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-xs text-slate-500 dark:border-white/10 dark:bg-white/5">
              No folder grants. This person sees no NAS storage — and no external storage in Nextcloud.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {folderGrants.map((assignment) => {
                const access = folderAccessLabel(assignment.roleId);
                return (
                  <li
                    key={assignment.id}
                    className="flex items-center gap-2.5 rounded-xl border border-gray-200 bg-gray-50/50 px-3 py-2 dark:border-white/10 dark:bg-white/[0.03]"
                  >
                    <Folder className="h-4 w-4 shrink-0 text-[#0078D4] dark:text-[#7cb9ff]" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-gray-900 dark:text-white">{scopeLabel(assignment.scope)}</p>
                      <p className="truncate font-mono text-[10px] text-slate-500">{assignment.scope}</p>
                    </div>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold",
                        access.rw
                          ? "bg-teal-500/15 text-teal-600 dark:text-teal-300"
                          : "bg-slate-500/15 text-slate-600 dark:text-slate-300",
                      )}
                    >
                      {access.rw ? <Pencil className="h-2.5 w-2.5" /> : <Lock className="h-2.5 w-2.5" />}
                      {access.label}
                    </span>
                    {canManage ? (
                      <button
                        type="button"
                        onClick={() => void submitRevokeFolder(assignment)}
                        disabled={revokeStorage.isPending}
                        title="Revoke this folder grant"
                        className="shrink-0 rounded-lg border border-gray-200 p-1.5 text-slate-500 transition-colors hover:border-red-500/40 hover:text-red-500 disabled:opacity-40 dark:border-white/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </ServiceTile>
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
          Grants apply automatically: Jellyfin provisions a local account with a generated password, and folders appear in the
          person&apos;s Nextcloud Files. Both are audited and honour the RBAC privilege ceiling.
        </span>
      </div>

      {grantingJellyfin ? (
        <GrantJellyfinSheet
          username={user.username}
          open
          onClose={() => {
            setGrantingJellyfin(false);
            void jellyfinQuery.refetch();
          }}
        />
      ) : null}
      {grantingFolder ? (
        <GrantFolderSheet
          username={user.username}
          open
          onClose={() => {
            setGrantingFolder(false);
            void assignmentsQuery.refetch();
          }}
        />
      ) : null}
    </motion.section>
  );
}
