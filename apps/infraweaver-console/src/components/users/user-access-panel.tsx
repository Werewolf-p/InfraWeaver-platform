"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  Globe, ShieldCheck, Pencil, Eye, Plus, Trash2, Loader2, Check,
  KeyRound, Clock, Layers, Sparkles,
} from "lucide-react";
import { toast } from "@/lib/notify";
import {
  getEffectivePermissions,
  resolveRoleDefinition,
  scopeLabel,
  type Permission,
  type RoleAssignment,
} from "@/lib/rbac";
import { queryKeys } from "@/lib/query-keys";
import { cn, formatDate } from "@/lib/utils";
import { useRBAC } from "@/hooks/use-rbac";
import type { PlatformUser } from "@/hooks/use-users-config";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";

interface Props {
  user: PlatformUser | null;
  isAdmin: boolean;
}

interface WordpressSite {
  site: string;
  host?: string;
  domain?: string;
}

/** Canonical scope used across the platform for a per-site WordPress grant. */
function wordpressSiteScope(site: string): string {
  return `/wordpress/sites/${site}`;
}

function parseWordpressSiteScope(scope: string): string | null {
  const match = scope.match(/^\/wordpress\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])$/);
  return match ? match[1] : null;
}

/**
 * The three WordPress access tiers, mapped onto the built-in `wordpress-*`
 * roles. Editor maps to `wordpress:write` (content/plugins/SSO), Admin to
 * `wordpress:admin` (full site, including deletion). Ordered low → high.
 */
type WordpressTier = "viewer" | "editor" | "admin";

interface TierMeta {
  tier: WordpressTier;
  roleId: "wordpress-viewer" | "wordpress-editor" | "wordpress-admin";
  label: string;
  icon: typeof Eye;
  grants: string;
  accent: string;
  ring: string;
  dot: string;
}

const WORDPRESS_TIERS: TierMeta[] = [
  {
    tier: "viewer",
    roleId: "wordpress-viewer",
    label: "Viewer",
    icon: Eye,
    grants: "Read-only. View the site dashboard and content. Cannot edit, publish, or change settings.",
    accent: "text-slate-600 dark:text-slate-300",
    ring: "border-slate-400/60 dark:border-slate-400/50",
    dot: "bg-slate-400",
  },
  {
    tier: "editor",
    roleId: "wordpress-editor",
    label: "Editor",
    icon: Pencil,
    grants: "Content & write access. Manage posts, pages, plugins, and SSO for this site. Cannot delete the site.",
    accent: "text-blue-600 dark:text-blue-300",
    ring: "border-blue-500/60",
    dot: "bg-blue-400",
  },
  {
    tier: "admin",
    roleId: "wordpress-admin",
    label: "Admin",
    icon: ShieldCheck,
    grants: "Full control. Everything an Editor can do, plus deleting the site and all destructive operations.",
    accent: "text-purple-600 dark:text-purple-300",
    ring: "border-purple-500/60",
    dot: "bg-purple-400",
  },
];

const TIER_BY_ROLE: Record<string, TierMeta> = Object.fromEntries(
  WORDPRESS_TIERS.map((tier) => [tier.roleId, tier]),
);

const RESOURCE_LABELS: Record<string, string> = {
  apps: "applications",
  config: "config files",
  catalog: "app catalog",
  users: "users",
  cluster: "cluster",
  security: "security reports",
  nas: "network storage",
  infra: "infrastructure",
  rbac: "RBAC assignments",
  platform: "platform",
  "game-hub": "game servers",
  wiki: "wiki",
  wordpress: "WordPress sites",
};

const ACTION_LABELS: Record<string, string> = {
  read: "View",
  write: "Manage",
  sync: "Sync",
  delete: "Delete",
  invite: "Invite",
  drain: "Drain",
  scale: "Scale",
  admin: "Administer",
  update: "Update",
  players: "Manage players on",
  console: "Console access to",
  files: "File access to",
  start: "Start",
  stop: "Stop",
  edit: "Edit",
};

function humanizePermission(permission: Permission): string {
  if (permission === "*") return "Full platform access";
  const [resource, action] = permission.split(":");
  const verb = ACTION_LABELS[action] ?? action;
  const noun = RESOURCE_LABELS[resource] ?? resource;
  return `${verb} ${noun}`;
}

/** Non-WordPress scope label (WordPress scopes get a friendlier site label). */
function genericScopeLabel(scope: string): string {
  const site = parseWordpressSiteScope(scope);
  if (site) return `Site: ${site}`;
  return scopeLabel(scope);
}

function GrantSiteAccessModal({
  sites,
  sitesLoading,
  existingScopes,
  onClose,
  onSave,
  saving,
}: {
  sites: WordpressSite[];
  sitesLoading: boolean;
  existingScopes: Set<string>;
  onClose: () => void;
  onSave: (payload: { roleId: string; scope: string; expiresAt?: string }) => void;
  saving: boolean;
}) {
  const [site, setSite] = useState<string>("");
  const [tier, setTier] = useState<WordpressTier>("editor");
  const [expiresAt, setExpiresAt] = useState("");

  const selectedTier = WORDPRESS_TIERS.find((entry) => entry.tier === tier) ?? WORDPRESS_TIERS[1];
  const alreadyGranted = site ? existingScopes.has(wordpressSiteScope(site)) : false;
  const canSubmit = Boolean(site) && !alreadyGranted && !saving;

  return (
    <ResponsiveSheet
      open
      onClose={onClose}
      size="md"
      title="Grant WordPress site access"
      description="Pick a site and the access level. The role is saved as a scoped RBAC assignment in users.yaml."
      footer={
        <div className="grid grid-cols-1 gap-3 sm:flex sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex min-h-[48px] items-center justify-center rounded-2xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-4 text-sm font-medium text-slate-700 dark:text-slate-300 transition-colors hover:text-gray-900 dark:hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() =>
              onSave({
                roleId: selectedTier.roleId,
                scope: wordpressSiteScope(site),
                expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
              })
            }
            className="inline-flex min-h-[48px] items-center justify-center gap-2 rounded-2xl border border-indigo-500/30 bg-indigo-500/20 px-4 text-sm font-semibold text-indigo-600 dark:text-indigo-300 transition-colors hover:bg-indigo-500/30 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Grant {selectedTier.label} access
          </button>
        </div>
      }
    >
      <div className="space-y-6">
        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">Site</label>
          {sitesLoading ? (
            <div className="flex items-center gap-2 rounded-2xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-4 py-3 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading sites…
            </div>
          ) : sites.length === 0 ? (
            <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
              No WordPress sites found. Create a site first from the WordPress section.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {sites.map((entry) => {
                const granted = existingScopes.has(wordpressSiteScope(entry.site));
                const active = site === entry.site;
                return (
                  <button
                    key={entry.site}
                    type="button"
                    onClick={() => setSite(entry.site)}
                    className={cn(
                      "inline-flex min-h-[44px] items-center gap-2 rounded-2xl border px-4 py-2 text-sm transition-colors",
                      active
                        ? "border-indigo-500/60 bg-indigo-500/15 text-indigo-700 dark:text-indigo-200"
                        : "border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 text-slate-700 dark:text-slate-300 hover:border-indigo-500/30",
                    )}
                  >
                    <Globe className="h-3.5 w-3.5 opacity-70" />
                    <span className="font-medium">{entry.site}</span>
                    {granted && (
                      <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-300">
                        has access
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {site && (
            <p className="mt-2 text-sm text-slate-500">
              Scope <span className="font-mono text-slate-600 dark:text-slate-400">{wordpressSiteScope(site)}</span>
            </p>
          )}
          {alreadyGranted && (
            <p className="mt-2 text-sm text-amber-600 dark:text-amber-300">
              This user already has access to <span className="font-semibold">{site}</span>. Remove the existing grant first to change the level.
            </p>
          )}
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">Access level</label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {WORDPRESS_TIERS.map((entry) => {
              const Icon = entry.icon;
              const active = tier === entry.tier;
              return (
                <button
                  key={entry.tier}
                  type="button"
                  onClick={() => setTier(entry.tier)}
                  aria-pressed={active}
                  className={cn(
                    "relative flex min-h-[112px] flex-col rounded-2xl border-2 p-4 text-left transition-all",
                    active
                      ? cn(entry.ring, "bg-white dark:bg-white/[0.07] shadow-sm")
                      : "border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 hover:border-gray-300 dark:hover:border-white/20",
                  )}
                >
                  {active && (
                    <span className={cn("absolute right-2 top-2 inline-flex h-5 w-5 items-center justify-center rounded-full", entry.accent)}>
                      <Check className="h-4 w-4" />
                    </span>
                  )}
                  <Icon className={cn("mb-1.5 h-5 w-5", entry.accent)} />
                  <p className={cn("text-sm font-semibold", entry.accent)}>{entry.label}</p>
                  <p className="mt-1 text-xs leading-snug text-slate-500 dark:text-slate-400">{entry.grants}</p>
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex items-start gap-2 rounded-2xl border border-indigo-500/20 bg-indigo-500/10 p-3 text-sm text-indigo-700 dark:text-indigo-200">
            <KeyRound className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span><span className="font-semibold">{selectedTier.label}</span> — {selectedTier.grants}</span>
          </div>
        </div>

        <div>
          <label className="mb-2 block text-sm font-medium text-slate-700 dark:text-slate-300">Expiry (optional)</label>
          <input
            type="datetime-local"
            value={expiresAt}
            onChange={(event) => setExpiresAt(event.target.value)}
            className="w-full rounded-2xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-4 py-3 text-base text-gray-900 dark:text-white focus:border-indigo-500/50 focus:outline-none"
          />
          <p className="mt-2 text-sm text-slate-500">Leave empty for a permanent grant. Expired grants stop conferring access automatically.</p>
        </div>
      </div>
    </ResponsiveSheet>
  );
}

export function UserAccessPanel({ user, isAdmin }: Props) {
  const { canAny } = useRBAC();
  const reduceMotion = useReducedMotion();
  const qc = useQueryClient();
  const canView = canAny(["users:read", "users:write", "rbac:admin"]);
  const canManage = isAdmin && canAny(["users:write", "rbac:admin"]);
  const [grantOpen, setGrantOpen] = useState(false);

  const assignmentsQuery = useQuery<{ role_assignments: RoleAssignment[] }>({
    queryKey: ["users-config", user?.username, "rbac"],
    enabled: Boolean(user) && canView,
    queryFn: async () => {
      const res = await fetch(`/api/users-config/${user?.username}/rbac`);
      if (!res.ok) throw new Error("Failed to load assignments");
      return res.json();
    },
  });

  const sitesQuery = useQuery<{ sites: WordpressSite[] }>({
    queryKey: ["wordpress", "sites", "access-panel"],
    enabled: canManage && grantOpen,
    queryFn: async () => {
      const res = await fetch("/api/wordpress/sites");
      if (!res.ok) throw new Error("Failed to load WordPress sites");
      return res.json();
    },
    staleTime: 30_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["users-config", user?.username, "rbac"] });
    qc.invalidateQueries({ queryKey: queryKeys.config.users() });
  };

  const grantMutation = useMutation({
    mutationFn: async (payload: { roleId: string; scope: string; expiresAt?: string }) => {
      const res = await fetch(`/api/users-config/${user?.username}/rbac`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, principalType: "user" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Failed to grant access");
      return data;
    },
    onSuccess: () => {
      toast.success("WordPress access granted");
      setGrantOpen(false);
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const revokeMutation = useMutation({
    mutationFn: async (assignmentId: string) => {
      const res = await fetch(`/api/users-config/${user?.username}/rbac`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignmentId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Failed to revoke access");
      return data;
    },
    onMutate: (assignmentId: string) => setPendingRevoke(assignmentId),
    onSuccess: () => {
      toast.success("WordPress access revoked");
      invalidate();
    },
    onError: (error: Error) => toast.error(error.message),
    onSettled: () => setPendingRevoke(null),
  });

  const [pendingRevoke, setPendingRevoke] = useState<string | null>(null);

  const assignments = useMemo(() => assignmentsQuery.data?.role_assignments ?? [], [assignmentsQuery.data]);

  const wordpressGrants = useMemo(
    () =>
      assignments
        .map((assignment) => {
          const site = parseWordpressSiteScope(assignment.scope);
          if (!site) return null;
          const tier = TIER_BY_ROLE[assignment.roleId];
          return { assignment, site, tier };
        })
        .filter((entry): entry is { assignment: RoleAssignment; site: string; tier: TierMeta } => entry !== null)
        .sort((a, b) => a.site.localeCompare(b.site)),
    [assignments],
  );

  const grantedScopes = useMemo(
    () => new Set(wordpressGrants.map((entry) => wordpressSiteScope(entry.site))),
    [wordpressGrants],
  );

  const effectivePermissions = useMemo(() => {
    if (!user) return [] as string[];
    const groups = user.authentik_groups ?? [];
    const perms = getEffectivePermissions(groups, user.username, assignments, "/");
    if (perms.has("*")) return ["Full platform access"];
    return [...perms].map(humanizePermission).sort();
  }, [user, assignments]);

  const otherAssignments = useMemo(
    () => assignments.filter((assignment) => !parseWordpressSiteScope(assignment.scope)),
    [assignments],
  );

  if (!user) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 px-4 py-10 text-center text-sm text-slate-500">
        Select a user to review their effective access.
      </div>
    );
  }

  const fadeUp = reduceMotion
    ? { initial: false, animate: { opacity: 1 } }
    : { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 } };

  return (
    <div className="space-y-4">
      {/* Effective access */}
      <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-200 dark:border-white/10">
          <Layers className="h-4 w-4 text-indigo-400" />
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
            Effective access · @{user.username}
          </h3>
        </div>
        <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
          <dl className="space-y-2.5 text-sm">
            <div className="flex items-center justify-between gap-4">
              <dt className="text-slate-500">Access level</dt>
              <dd className="font-medium text-gray-900 dark:text-white">{user.access_level}</dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-slate-500">Wiki role</dt>
              <dd className="text-slate-700 dark:text-slate-300">{user.wiki_role ?? "—"}</dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt className="text-slate-500">ArgoCD role</dt>
              <dd className="text-slate-700 dark:text-slate-300">{user.argocd_role || "—"}</dd>
            </div>
            <div className="flex items-start justify-between gap-4">
              <dt className="text-slate-500 pt-0.5">Groups</dt>
              <dd className="flex flex-wrap justify-end gap-1">
                {(user.authentik_groups ?? []).length === 0 ? (
                  <span className="text-slate-700 dark:text-slate-300">—</span>
                ) : (
                  (user.authentik_groups ?? []).map((group) => (
                    <span key={group} className="rounded bg-gray-200/70 dark:bg-white/10 px-1.5 py-0.5 text-xs text-slate-600 dark:text-slate-300">
                      {group}
                    </span>
                  ))
                )}
              </dd>
            </div>
          </dl>
          <div>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-slate-500">
              <Sparkles className="h-3.5 w-3.5" /> Resolved permissions
            </p>
            {assignmentsQuery.isLoading ? (
              <div className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Resolving…</div>
            ) : effectivePermissions.length === 0 ? (
              <p className="text-sm text-slate-500">No effective permissions.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {effectivePermissions.map((perm) => (
                  <span
                    key={perm}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-xs",
                      perm === "Full platform access"
                        ? "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-300 font-medium"
                        : "border-gray-200 dark:border-white/10 bg-white/60 dark:bg-white/5 text-slate-600 dark:text-slate-300",
                    )}
                  >
                    {perm}
                  </span>
                ))}
              </div>
            )}
            {otherAssignments.length > 0 && (
              <p className="mt-3 text-xs text-slate-500">
                Includes {otherAssignments.length} scoped assignment{otherAssignments.length === 1 ? "" : "s"} outside WordPress (see Role Assignments below).
              </p>
            )}
          </div>
        </div>
      </div>

      {/* WordPress per-site access */}
      <div className="rounded-xl border border-gray-200 dark:border-white/10 bg-gray-100 dark:bg-white/5 overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-200 dark:border-white/10">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
              <Globe className="h-4 w-4 text-blue-400" />
              WordPress site access
            </h3>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Per-site grants. Editor manages content &amp; plugins; Admin adds full control including deletion.
            </p>
          </div>
          {canManage && (
            <button
              onClick={() => setGrantOpen(true)}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-indigo-500/30 bg-indigo-500/20 px-3 py-2 text-sm text-indigo-600 dark:text-indigo-300 transition-colors hover:bg-indigo-500/30"
            >
              <Plus className="h-4 w-4" /> Grant access
            </button>
          )}
        </div>

        {!canView ? (
          <div className="px-4 py-10 text-center text-sm text-slate-500">You do not have permission to view access grants.</div>
        ) : assignmentsQuery.isLoading ? (
          <div className="flex items-center justify-center px-4 py-10 text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /></div>
        ) : wordpressGrants.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-500">
            No WordPress site access yet.
            {canManage && " Use “Grant access” to give this user Editor or Admin rights on a specific site."}
          </div>
        ) : (
          <ul className="divide-y divide-gray-200/70 dark:divide-white/5">
            <AnimatePresence initial={false}>
              {wordpressGrants.map(({ assignment, site, tier }) => {
                const role = resolveRoleDefinition(assignment.roleId);
                const Icon = tier?.icon ?? KeyRound;
                return (
                  <motion.li
                    key={assignment.id}
                    layout={!reduceMotion}
                    {...fadeUp}
                    exit={reduceMotion ? undefined : { opacity: 0, x: -12 }}
                    className="flex items-start justify-between gap-4 px-4 py-3"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <span className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-gray-200 dark:border-white/10 bg-white/60 dark:bg-white/5", tier?.accent)}>
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-gray-900 dark:text-white">
                          <span className="inline-flex items-center gap-1"><Globe className="h-3.5 w-3.5 opacity-60" /> {site}</span>
                          <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold", tier ? cn(tier.ring, "bg-white/40 dark:bg-white/5", tier.accent) : "border-gray-200 dark:border-white/10 text-slate-500")}>
                            {tier?.label ?? assignment.roleId}
                          </span>
                          {assignment.expiresAt && (
                            <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-300">
                              <Clock className="h-3 w-3" /> Expires {formatDate(assignment.expiresAt)}
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                          {(role?.permissions ?? []).map(humanizePermission).join(" · ") || genericScopeLabel(assignment.scope)}
                        </p>
                        <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">
                          Granted by {assignment.grantedBy} on {formatDate(assignment.grantedAt)}
                        </p>
                      </div>
                    </div>
                    {canManage && (
                      <button
                        onClick={() => revokeMutation.mutate(assignment.id)}
                        disabled={pendingRevoke === assignment.id}
                        aria-label={`Revoke ${tier?.label ?? "access"} on ${site}`}
                        className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                      >
                        {pendingRevoke === assignment.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      </button>
                    )}
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        )}
      </div>

      {grantOpen && canManage && (
        <GrantSiteAccessModal
          sites={sitesQuery.data?.sites ?? []}
          sitesLoading={sitesQuery.isLoading}
          existingScopes={grantedScopes}
          onClose={() => setGrantOpen(false)}
          onSave={(payload) => grantMutation.mutate(payload)}
          saving={grantMutation.isPending}
        />
      )}
    </div>
  );
}
