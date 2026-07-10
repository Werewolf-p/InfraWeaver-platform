"use client";

// "Which NAS folders can this person reach" — and the flow to give them one.
//
// The mirror image of `components/nas/storage-access-sheet.tsx`. That sheet starts
// at a folder and picks a person; this one starts at a person and picks a folder.
// Both write the same thing: an ordinary RBAC role assignment on a `/nas/...`
// scope (see lib/nas/scope.ts), so there is exactly one source of truth and the
// RBAC visualizer sees every grant either flow makes.
//
// Granting here also reconciles the folder's Authentik access groups, which is
// what makes the folder appear in that person's Nextcloud Files view. No manual
// Nextcloud step, and no way for the two to drift.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  Eye,
  Folder,
  HardDrive,
  Home,
  Info,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { cn, formatDate } from "@/lib/utils";
import { scopeLabel, type RoleAssignment } from "@/lib/rbac";
import type { PlatformUser } from "@/hooks/use-users-config";
import { useNasFolders, useNasProviders, useNasShares } from "@/hooks/use-nas";
import { useGrantStorageAccess, useRevokeStorageAccess, type StorageRoleId } from "@/hooks/use-storage-access";

interface Props {
  user: PlatformUser | null;
  isAdmin: boolean;
}

const TIERS: Array<{ roleId: StorageRoleId; label: string; grants: string; icon: typeof Eye; accent: string; ring: string }> = [
  {
    roleId: "storage-viewer",
    label: "Viewer",
    grants: "Browse the folder and mount it read-only. Read-only in Nextcloud.",
    icon: Eye,
    accent: "text-slate-600 dark:text-slate-300",
    ring: "border-slate-400/60",
  },
  {
    roleId: "storage-contributor",
    label: "Contributor",
    grants: "Also create subfolders and mount read-write. Can add files in Nextcloud.",
    icon: Pencil,
    accent: "text-teal-600 dark:text-teal-300",
    ring: "border-teal-500/60",
  },
];

const ROLE_LABEL: Record<string, string> = {
  "storage-viewer": "Viewer",
  "storage-contributor": "Contributor",
};

/** Only `/nas/...` assignments belong in this panel; the rest live in the RBAC panel. */
function isStorageScope(scope: string): boolean {
  return scope === "/nas" || scope.startsWith("/nas/");
}

function GrantFolderSheet({
  username,
  open,
  onClose,
}: {
  username: string;
  open: boolean;
  onClose: () => void;
}) {
  const providersQuery = useNasProviders();
  const providers = useMemo(
    () => (providersQuery.data ?? []).filter((provider) => provider.hasCredentials),
    [providersQuery.data],
  );

  const [chosenProvider, setChosenProvider] = useState("");
  const providerId = chosenProvider || providers[0]?.id || "";
  const [share, setShare] = useState("");
  const [path, setPath] = useState("");
  const [tier, setTier] = useState<StorageRoleId>("storage-viewer");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);

  const sharesQuery = useNasShares(providerId || null);
  const foldersQuery = useNasFolders(providerId || null, share || null, path);
  const grant = useGrantStorageAccess();

  const folders = foldersQuery.data?.folders ?? [];
  const selectedTier = TIERS.find((entry) => entry.roleId === tier) ?? TIERS[0];
  const crumbs = path.split("/").filter(Boolean);

  async function submit() {
    setError(null);
    try {
      await grant.mutateAsync({
        provider: providerId,
        share,
        ...(path ? { path } : {}),
        roleId: tier,
        principalType: "user",
        principal: username,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to grant folder access");
    }
  }

  return (
    <ResponsiveSheet
      open={open}
      onClose={onClose}
      size="lg"
      title={`Grant ${username} access to a folder`}
      description={
        share
          ? <span className="font-mono text-xs text-slate-500">/{[providerId, share, path].filter(Boolean).join("/")}</span>
          : <span className="text-xs text-slate-500">Pick a share, then drill into the folder to grant.</span>
      }
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-[48px] items-center justify-center rounded-2xl border border-gray-200 px-4 text-sm text-slate-600 dark:border-white/10 dark:text-slate-300"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!share || grant.isPending}
            onClick={() => void submit()}
            className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-2xl border border-[#0078D4]/30 bg-[#0078D4]/20 px-4 text-sm font-semibold text-[#7cb9ff] transition-colors hover:bg-[#0078D4]/30 disabled:opacity-50"
          >
            {grant.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Grant {selectedTier.label}
          </button>
        </div>
      }
    >
      <div className="space-y-6">
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">Provider</label>
          {providers.length === 0 ? (
            <p className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
              No NAS provider has credentials yet. Add one from the Storage page first.
            </p>
          ) : (
            <select
              value={providerId}
              onChange={(event) => { setChosenProvider(event.target.value); setShare(""); setPath(""); }}
              className="w-full rounded-2xl border border-gray-200 bg-gray-100 px-4 py-3 text-sm text-gray-900 dark:border-white/10 dark:bg-white/5 dark:text-white"
            >
              {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
          )}
        </div>

        {providerId ? (
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">Folder</label>

            <div className="mb-2 flex flex-wrap items-center gap-1 text-sm">
              <button
                type="button"
                onClick={() => { setShare(""); setPath(""); }}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-slate-500 transition-colors hover:text-gray-900 dark:hover:text-white"
              >
                <Home className="h-3.5 w-3.5" /> Shares
              </button>
              {share ? (
                <>
                  <ChevronRight className="h-3.5 w-3.5 text-slate-600" />
                  <button
                    type="button"
                    onClick={() => setPath("")}
                    className={cn("rounded-md px-1.5 py-1 transition-colors", path ? "text-slate-500 hover:text-gray-900 dark:hover:text-white" : "font-medium text-gray-900 dark:text-white")}
                  >
                    {share}
                  </button>
                </>
              ) : null}
              {crumbs.map((label, index) => (
                <span key={label} className="flex items-center gap-1">
                  <ChevronRight className="h-3.5 w-3.5 text-slate-600" />
                  <button
                    type="button"
                    onClick={() => setPath(crumbs.slice(0, index + 1).join("/"))}
                    className={cn("rounded-md px-1.5 py-1 transition-colors", index === crumbs.length - 1 ? "font-medium text-gray-900 dark:text-white" : "text-slate-500 hover:text-gray-900 dark:hover:text-white")}
                  >
                    {label}
                  </button>
                </span>
              ))}
            </div>

            <div className="max-h-52 overflow-y-auto rounded-2xl border border-gray-200 dark:border-white/10">
              {!share ? (
                sharesQuery.isLoading ? (
                  <p className="flex items-center gap-2 px-4 py-3 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading shares…</p>
                ) : (sharesQuery.data ?? []).length === 0 ? (
                  <p className="px-4 py-3 text-sm text-slate-500">No shares visible on this provider.</p>
                ) : (
                  (sharesQuery.data ?? []).map((entry) => (
                    <button
                      key={entry.name}
                      type="button"
                      onClick={() => { setShare(entry.name); setPath(""); }}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-gray-100 dark:hover:bg-white/5"
                    >
                      <HardDrive className="h-4 w-4 shrink-0 text-[#7cb9ff]" />
                      <span className="truncate text-sm text-gray-900 dark:text-white">{entry.name}</span>
                    </button>
                  ))
                )
              ) : foldersQuery.isLoading ? (
                <p className="flex items-center gap-2 px-4 py-3 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading folders…</p>
              ) : folders.length === 0 ? (
                <p className="px-4 py-3 text-sm text-slate-500">
                  No subfolders here. Grant on this folder itself — the grant reaches everything beneath it.
                </p>
              ) : (
                folders.map((folder) => (
                  <button
                    key={folder.subfolder}
                    type="button"
                    onClick={() => setPath(folder.subfolder)}
                    className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-gray-100 dark:hover:bg-white/5"
                  >
                    <Folder className="h-4 w-4 shrink-0 text-[#7cb9ff]" />
                    <span className="truncate text-sm text-gray-900 dark:text-white">{folder.name}</span>
                    <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-slate-500" />
                  </button>
                ))
              )}
            </div>
            {share ? (
              <p className="mt-2 flex items-start gap-2 text-xs leading-snug text-slate-500">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                The grant lands on the folder shown in the breadcrumb and reaches every folder beneath it.
              </p>
            ) : null}
          </div>
        ) : null}

        {share ? (
          <>
            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">Access level</label>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {TIERS.map((entry) => {
                  const Icon = entry.icon;
                  const active = tier === entry.roleId;
                  return (
                    <button
                      key={entry.roleId}
                      type="button"
                      onClick={() => setTier(entry.roleId)}
                      aria-pressed={active}
                      className={cn(
                        "relative flex min-h-[104px] flex-col rounded-2xl border-2 p-4 text-left transition-all",
                        active ? cn(entry.ring, "bg-white shadow-sm dark:bg-white/[0.07]") : "border-gray-200 bg-gray-100 hover:border-gray-300 dark:border-white/10 dark:bg-white/5 dark:hover:border-white/20",
                      )}
                    >
                      {active ? (
                        <span className={cn("absolute right-2 top-2 inline-flex h-5 w-5 items-center justify-center rounded-full", entry.accent)}>
                          <Check className="h-4 w-4" />
                        </span>
                      ) : null}
                      <Icon className={cn("mb-1.5 h-5 w-5", entry.accent)} />
                      <p className={cn("text-sm font-semibold", entry.accent)}>{entry.label}</p>
                      <p className="mt-1 text-xs leading-snug text-slate-500 dark:text-slate-400">{entry.grants}</p>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">Expiry (optional)</label>
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
                className="w-full rounded-2xl border border-gray-200 bg-gray-100 px-4 py-3 text-base text-gray-900 focus:border-[#0078D4]/50 focus:outline-none dark:border-white/10 dark:bg-white/5 dark:text-white"
              />
              <p className="mt-2 text-xs text-slate-500">Leave empty for a permanent grant.</p>
            </div>
          </>
        ) : null}

        {error ? <p className="text-sm text-red-500">{error}</p> : null}
      </div>
    </ResponsiveSheet>
  );
}

export function UserStorageAccessPanel({ user, isAdmin }: Props) {
  const [granting, setGranting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revoke = useRevokeStorageAccess();

  const assignmentsQuery = useQuery<{ role_assignments: RoleAssignment[] }>({
    queryKey: ["users-config", user?.username, "rbac"],
    queryFn: async () => {
      const res = await fetch(`/api/users-config/${user?.username}/rbac`);
      if (!res.ok) throw new Error("Failed to load role assignments");
      return await res.json() as { role_assignments: RoleAssignment[] };
    },
    enabled: Boolean(user?.username),
  });

  const storageGrants = useMemo(
    () => (assignmentsQuery.data?.role_assignments ?? []).filter((assignment) => isStorageScope(assignment.scope)),
    [assignmentsQuery.data],
  );

  if (!user) return null;

  async function submitRevoke(assignment: RoleAssignment) {
    setError(null);
    try {
      await revoke.mutateAsync({ assignmentId: assignment.id, principalType: "user", principal: user!.username });
      await assignmentsQuery.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke folder access");
    }
  }

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 dark:border-[#2a2a2a] dark:bg-[#111]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
            <HardDrive className="h-4 w-4 text-[#7cb9ff]" />
            Storage access
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            NAS folders {user.name || user.username} can reach. Also decides what they see in Nextcloud.
          </p>
        </div>
        {isAdmin ? (
          <button
            type="button"
            onClick={() => setGranting(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[#0078D4]/30 bg-[#0078D4]/10 px-2.5 py-1.5 text-xs font-medium text-[#7cb9ff] transition-colors hover:bg-[#0078D4]/20"
          >
            <Plus className="h-3.5 w-3.5" />
            Grant folder access
          </button>
        ) : null}
      </div>

      {assignmentsQuery.isLoading ? (
        <p className="flex items-center gap-2 py-3 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</p>
      ) : storageGrants.length === 0 ? (
        <p className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-slate-500 dark:border-white/10 dark:bg-white/5">
          No folder grants. This person sees no NAS storage — and no external storage in Nextcloud.
        </p>
      ) : (
        <ul className="divide-y divide-gray-200 overflow-hidden rounded-xl border border-gray-200 dark:divide-[#1c1c1c] dark:border-[#2a2a2a]">
          {storageGrants.map((assignment) => (
            <li key={assignment.id} className="flex items-center gap-3 p-3">
              <Folder className="h-4 w-4 shrink-0 text-[#7cb9ff]" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 truncate text-sm font-medium text-gray-900 dark:text-white">
                  {scopeLabel(assignment.scope)}
                  <span className="rounded-full bg-teal-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-teal-600 dark:text-teal-300">
                    {ROLE_LABEL[assignment.roleId] ?? assignment.roleId}
                  </span>
                </p>
                <p className="mt-0.5 truncate font-mono text-[11px] text-slate-500">
                  {assignment.scope}
                  {assignment.expiresAt ? ` · expires ${formatDate(assignment.expiresAt)}` : ""}
                </p>
              </div>
              {isAdmin ? (
                <button
                  type="button"
                  onClick={() => void submitRevoke(assignment)}
                  disabled={revoke.isPending}
                  title="Revoke this folder grant"
                  className="shrink-0 rounded-lg border border-gray-200 p-1.5 text-slate-500 transition-colors hover:border-red-500/40 hover:text-red-500 disabled:opacity-40 dark:border-white/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {error ? <p className="mt-2 text-sm text-red-500">{error}</p> : null}

      {granting ? (
        <GrantFolderSheet
          username={user.username}
          open
          onClose={() => { setGranting(false); void assignmentsQuery.refetch(); }}
        />
      ) : null}
    </div>
  );
}
