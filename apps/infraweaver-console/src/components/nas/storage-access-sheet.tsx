"use client";

// "Who can reach this folder, and why" — plus the controls to change it.
//
// A storage grant is an ordinary RBAC role assignment on a `/nas/...` scope, so
// this sheet is doing exactly what the RBAC settings page does, narrowed to one
// folder and phrased in storage terms. Two things it must always make obvious,
// because getting them wrong is how people hand out the finance share:
//
//   * INHERITANCE. A grant on `media` reaches `media/movies`. Inherited grants
//     are listed here but can only be revoked where they were made, so they are
//     shown with their real scope and a disabled revoke.
//   * THE OWNER. The platform owner holds `*` and reaches every folder without
//     any grant at all. A list that showed only grants would imply otherwise.

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Crown,
  Eye,
  Info,
  KeyRound,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  Users,
  UserRound,
} from "lucide-react";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { cn } from "@/lib/utils";
import {
  useGrantStorageAccess,
  useRevokeStorageAccess,
  useStorageAccess,
  useSyncShareAccess,
  type StorageGrant,
  type StorageRoleId,
} from "@/hooks/use-storage-access";

interface StorageAccessSheetProps {
  open: boolean;
  onClose: () => void;
  provider: string;
  share: string;
  /** Share-relative folder; "" targets the share itself. */
  subfolder: string;
}

interface Tier {
  roleId: StorageRoleId;
  label: string;
  grants: string;
  icon: typeof Eye;
  accent: string;
  ring: string;
}

const TIERS: Tier[] = [
  {
    roleId: "storage-viewer",
    label: "Viewer",
    grants: "Browse this folder and mount it into a workload read-only.",
    icon: Eye,
    accent: "text-slate-600 dark:text-slate-300",
    ring: "border-slate-400/60",
  },
  {
    roleId: "storage-contributor",
    label: "Contributor",
    grants: "Everything a Viewer can do, plus create subfolders and mount read-write.",
    icon: Pencil,
    accent: "text-teal-600 dark:text-teal-300",
    ring: "border-teal-500/60",
  },
];

const ROLE_LABEL: Record<string, string> = {
  "storage-viewer": "Viewer",
  "storage-contributor": "Contributor",
};

/** A grant made by a role that is not one of the storage tiers (e.g. platform-owner at "/"). */
function roleLabel(roleId: string): string {
  return ROLE_LABEL[roleId] ?? roleId;
}

function isExpired(grant: StorageGrant): boolean {
  return Boolean(grant.expiresAt && new Date(grant.expiresAt) < new Date());
}

export function StorageAccessSheet({ open, onClose, provider, share, subfolder }: StorageAccessSheetProps) {
  const location = useMemo(
    () => ({ provider, share, ...(subfolder ? { path: subfolder } : {}) }),
    [provider, share, subfolder],
  );
  const accessQuery = useStorageAccess(open ? location : null);
  const grantAccess = useGrantStorageAccess();
  const revokeAccess = useRevokeStorageAccess();
  const syncGroups = useSyncShareAccess();

  const [principalType, setPrincipalType] = useState<"user" | "group">("user");
  const [principal, setPrincipal] = useState("");
  const [tier, setTier] = useState<StorageRoleId>("storage-viewer");
  const [expiresAt, setExpiresAt] = useState("");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const data = accessQuery.data;
  const canManage = data?.canManage ?? false;
  const label = data?.label ?? [provider, share, subfolder].filter(Boolean).join(" / ");

  const candidates = useMemo(() => {
    if (!data) return [] as Array<{ id: string; primary: string; secondary: string }>;
    const needle = filter.trim().toLowerCase();
    const rows = principalType === "user"
      ? data.candidates.users.map((user) => ({ id: user.username, primary: user.name || user.username, secondary: user.email || user.username }))
      : data.candidates.groups.map((group) => ({ id: group, primary: group, secondary: "Authentik group" }));
    if (!needle) return rows;
    return rows.filter((row) => `${row.id} ${row.primary} ${row.secondary}`.toLowerCase().includes(needle));
  }, [data, filter, principalType]);

  const selectedTier = TIERS.find((entry) => entry.roleId === tier) ?? TIERS[0];

  // A grant that already exists at this exact scope for this principal cannot be
  // re-made (the server 409s); surface it before the round trip.
  const alreadyGranted = Boolean(
    principal
    && data?.grants.some(
      (grant) => !grant.inherited && grant.principalId === principal && grant.principalType === principalType && grant.roleId === tier,
    ),
  );

  async function submitGrant() {
    if (!principal) return;
    setError(null);
    setNotice(null);
    try {
      await grantAccess.mutateAsync({
        ...location,
        roleId: tier,
        principalType,
        principal,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      });
      setPrincipal("");
      setExpiresAt("");
      setNotice(`Granted ${selectedTier.label} on ${label}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to grant access");
    }
  }

  async function submitRevoke(grant: StorageGrant) {
    setError(null);
    setNotice(null);
    try {
      await revokeAccess.mutateAsync({
        assignmentId: grant.assignmentId,
        principalType: grant.principalType,
        principal: grant.principalId,
      });
      setNotice(`Revoked ${roleLabel(grant.roleId)} from ${grant.principalId}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke access");
    }
  }

  async function submitSync() {
    setError(null);
    setNotice(null);
    try {
      const result = await syncGroups.mutateAsync(location);
      const unknown = [...new Set([...result.readonly.unknown, ...result.readwrite.unknown])];
      setNotice(
        `Access groups reconciled: ${result.readwrite.applied.length} read-write, ${result.readonly.applied.length} read-only member(s).`
        + (unknown.length ? ` Skipped (never signed in): ${unknown.join(", ")}.` : ""),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to sync access groups");
    }
  }

  const grants = data?.grants ?? [];
  const busy = grantAccess.isPending || revokeAccess.isPending;

  return (
    <ResponsiveSheet
      open={open}
      onClose={onClose}
      size="lg"
      title={<span className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-[#7cb9ff]" />Access to {label}</span>}
      description={
        <span className="font-mono text-xs text-slate-500">{data?.scope ?? "resolving scope…"}</span>
      }
      footer={
        canManage ? (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <button
              type="button"
              onClick={() => void submitSync()}
              disabled={syncGroups.isPending}
              className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-2xl border border-gray-200 px-4 text-sm text-slate-600 transition-colors hover:text-gray-900 disabled:opacity-50 dark:border-white/10 dark:text-slate-300 dark:hover:text-white"
              title="Reconcile this share's Authentik groups with RBAC. Nextcloud reads those groups to decide who sees the folder."
            >
              {syncGroups.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Sync access groups
            </button>
            <button
              type="button"
              disabled={!principal || alreadyGranted || busy}
              onClick={() => void submitGrant()}
              className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-2xl border border-[#0078D4]/30 bg-[#0078D4]/20 px-4 text-sm font-semibold text-[#7cb9ff] transition-colors hover:bg-[#0078D4]/30 disabled:opacity-50"
            >
              {grantAccess.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Grant {selectedTier.label}
            </button>
          </div>
        ) : null
      }
    >
      <div className="space-y-6">
        {accessQuery.isError ? (
          <p className="rounded-2xl border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-300">
            {(accessQuery.error as Error).message}
          </p>
        ) : null}

        <div className="flex items-start gap-2 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-200">
          <Crown className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Platform owners hold <span className="font-mono text-xs">*</span> and reach every folder without a grant, so they never appear below.
            Grants shown here are what everyone <em>else</em> gets.
          </span>
        </div>

        {data?.accessGroups ? (
          <div className="rounded-2xl border border-gray-200 bg-gray-50 p-3 text-xs dark:border-white/10 dark:bg-white/5">
            <p className="mb-1.5 font-medium text-slate-700 dark:text-slate-300">Authentik groups driven by these grants</p>
            <p className="font-mono text-[11px] text-slate-600 dark:text-slate-400">{data.accessGroups.readwrite}</p>
            <p className="font-mono text-[11px] text-slate-600 dark:text-slate-400">{data.accessGroups.readonly}</p>
            <p className="mt-1.5 leading-snug text-slate-500">
              An app that scopes by group — Nextcloud external storage — should bind these names. Membership is reconciled from the grants above,
              so it is never edited by hand.
            </p>
          </div>
        ) : null}

        {/* ── Current access ─────────────────────────────────────────── */}
        <section>
          <h3 className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-300">Who has access</h3>
          {accessQuery.isLoading ? (
            <p className="flex items-center gap-2 px-1 py-3 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading grants…</p>
          ) : grants.length === 0 ? (
            <p className="rounded-2xl border border-gray-200 bg-gray-100 px-4 py-3 text-sm text-slate-500 dark:border-white/10 dark:bg-white/5">
              No grants. Only platform owners and admins can reach this folder.
            </p>
          ) : (
            <ul className="divide-y divide-gray-200 overflow-hidden rounded-2xl border border-gray-200 dark:divide-[#1c1c1c] dark:border-[#2a2a2a]">
              {grants.map((grant) => {
                const expired = isExpired(grant);
                return (
                  <li key={grant.assignmentId} className="flex items-center gap-3 bg-white p-3 dark:bg-[#111]">
                    <span className={cn(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                      grant.principalType === "group" ? "bg-purple-500/10 text-purple-500" : "bg-[#0078D4]/10 text-[#7cb9ff]",
                    )}>
                      {grant.principalType === "group" ? <Users className="h-4 w-4" /> : <UserRound className="h-4 w-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-1.5 truncate text-sm font-medium text-gray-900 dark:text-white">
                        {grant.principalId}
                        <span className="rounded-full bg-teal-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-teal-600 dark:text-teal-300">
                          {roleLabel(grant.roleId)}
                        </span>
                        {grant.effect === "Deny" ? (
                          <span className="rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-600 dark:text-red-300">Deny</span>
                        ) : null}
                        {expired ? (
                          <span className="rounded-full bg-gray-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">Expired</span>
                        ) : null}
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-slate-500">
                        {grant.inherited ? (
                          <>Inherited from <span className="font-mono">{grant.scope}</span></>
                        ) : (
                          <>Granted by {grant.grantedBy}</>
                        )}
                        {grant.expiresAt ? <> · expires {new Date(grant.expiresAt).toLocaleString()}</> : null}
                      </p>
                    </div>
                    {canManage ? (
                      <button
                        type="button"
                        onClick={() => void submitRevoke(grant)}
                        disabled={grant.inherited || revokeAccess.isPending}
                        title={grant.inherited ? `Revoke this at ${grant.scope}, where it was granted` : "Revoke this grant"}
                        className="shrink-0 rounded-lg border border-gray-200 p-1.5 text-slate-500 transition-colors hover:border-red-500/40 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {!canManage ? (
          <p className="flex items-start gap-2 rounded-2xl border border-gray-200 bg-gray-100 p-3 text-sm text-slate-500 dark:border-white/10 dark:bg-white/5">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            Changing storage access needs <span className="font-mono text-xs">users:write</span> or <span className="font-mono text-xs">rbac:admin</span>.
          </p>
        ) : (
          <>
            {/* ── Grant ────────────────────────────────────────────── */}
            <section>
              <h3 className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-300">Grant access to</h3>
              <div className="mb-2 inline-flex rounded-2xl border border-gray-200 p-1 dark:border-white/10">
                {(["user", "group"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => { setPrincipalType(value); setPrincipal(""); }}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium capitalize transition-colors",
                      principalType === value ? "bg-[#0078D4]/15 text-[#7cb9ff]" : "text-slate-500 hover:text-gray-900 dark:hover:text-white",
                    )}
                  >
                    {value === "group" ? <Users className="h-3.5 w-3.5" /> : <UserRound className="h-3.5 w-3.5" />}
                    {value}
                  </button>
                ))}
              </div>

              <div className="relative mb-2">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder={principalType === "user" ? "Search users…" : "Search groups…"}
                  className="w-full rounded-2xl border border-gray-200 bg-gray-100 py-2 pl-9 pr-3 text-sm text-gray-900 focus:border-[#0078D4]/50 focus:outline-none dark:border-white/10 dark:bg-white/5 dark:text-white"
                />
              </div>

              <div className="max-h-44 overflow-y-auto rounded-2xl border border-gray-200 dark:border-white/10">
                {candidates.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-slate-500">
                    {principalType === "group" ? "No groups defined in users.yaml." : "No users match."}
                  </p>
                ) : (
                  candidates.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      onClick={() => setPrincipal(row.id)}
                      className={cn(
                        "flex w-full items-center gap-3 px-3 py-2 text-left transition-colors",
                        principal === row.id ? "bg-[#0078D4]/10" : "hover:bg-gray-100 dark:hover:bg-white/5",
                      )}
                    >
                      <span className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                        principal === row.id ? "border-[#0078D4] bg-[#0078D4] text-white" : "border-gray-300 dark:border-white/20",
                      )}>
                        {principal === row.id ? <Check className="h-3 w-3" /> : null}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-gray-900 dark:text-white">{row.primary}</span>
                        <span className="block truncate text-[11px] text-slate-500">{row.secondary}</span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            </section>

            {/* ── Tier ─────────────────────────────────────────────── */}
            <section>
              <h3 className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-300">Access level</h3>
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
                        active
                          ? cn(entry.ring, "bg-white shadow-sm dark:bg-white/[0.07]")
                          : "border-gray-200 bg-gray-100 hover:border-gray-300 dark:border-white/10 dark:bg-white/5 dark:hover:border-white/20",
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
              <p className="mt-2 flex items-start gap-2 text-xs leading-snug text-slate-500">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                This grant reaches every folder beneath {subfolder ? <span className="font-mono">{subfolder}</span> : <span className="font-mono">{share}</span>}.
                Mounting into a workload additionally requires <span className="font-mono">catalog:write</span>.
              </p>
            </section>

            {/* ── Expiry ───────────────────────────────────────────── */}
            <section>
              <h3 className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-300">Expiry (optional)</h3>
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
                className="w-full rounded-2xl border border-gray-200 bg-gray-100 px-4 py-3 text-base text-gray-900 focus:border-[#0078D4]/50 focus:outline-none dark:border-white/10 dark:bg-white/5 dark:text-white"
              />
              <p className="mt-2 text-xs text-slate-500">Leave empty for a permanent grant. Expired grants stop conferring access automatically.</p>
            </section>

            {alreadyGranted ? (
              <p className="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span><span className="font-semibold">{principal}</span> already holds {selectedTier.label} here. Revoke it first to change the level.</span>
              </p>
            ) : null}
          </>
        )}

        {error ? <p className="text-sm text-red-500">{error}</p> : null}
        {notice ? <p className="text-sm text-emerald-600 dark:text-emerald-300">{notice}</p> : null}
      </div>
    </ResponsiveSheet>
  );
}
