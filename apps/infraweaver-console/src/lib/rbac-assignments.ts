import "server-only";
import { randomUUID } from "node:crypto";
import { auditLog } from "@/lib/audit-log";
import { ROOT_SCOPE, assignmentExceedsGranter, getBuiltInRoles, type Permission, type RoleAssignment } from "@/lib/rbac";
import { retryWithBackoff } from "@/lib/retry";
import { errorMessage } from "@/lib/utils";
import { isNasScope, parseNasScope } from "@/lib/nas/scope";
import {
  loadUsersConfig,
  normalizeGroupRoleAssignments,
  normalizeRoleAssignments,
  saveUsersConfig,
} from "@/lib/users-config";
import { notifyRoleAssignmentChangeByEmail } from "@/lib/rbac-change-email";

/**
 * Fire-and-forget: email the affected USER a plain-language diff of their access
 * change. Group-principal changes are intentionally not mailed here (they fan out to
 * many members). The notifier never throws and never blocks the RBAC write.
 */
function notifyRbacChange(username: string, before: RoleAssignment[], after: RoleAssignment[]): void {
  void notifyRoleAssignmentChangeByEmail({ username, before, after });
}

/**
 * Shared grant/revoke logic for role assignments, used by both
 * `/api/rbac/assignments` and `/api/users-config/[username]/rbac`. Centralizes:
 *   load users.yaml → privilege-ceiling check → persist → audit.
 *
 * User-principal assignments are stored on the target user record; GROUP-principal
 * assignments are stored under the top-level `groups:` section with the group as
 * principal, so `getEffectivePermissions`' group filter resolves them for members.
 */

export interface GrantAssignmentInput {
  roleId: string;
  scope: string;
  principalType: "user" | "group";
  /** Username (for user principals) or Authentik group name (for group principals). */
  principal: string;
  expiresAt?: string;
  effect?: "Allow" | "Deny";
}

export interface AssignmentActionContext {
  /**
   * Resolves the granter's full effective permission set AT a given scope, for
   * the scope-aware privilege ceiling. Evaluating at the assignment's own scope
   * (not a fixed "/") ensures a Deny scoped to a subtree correctly lowers the
   * ceiling there — so a granter who is Denied at /wordpress cannot grant back
   * wordpress permissions at /wordpress that their own Deny withholds.
   */
  granterPermsAt: (scope: string) => Set<Permission>;
  /** Actor identity recorded in git commit + audit log. */
  actor: string;
}

export type AssignmentActionResult =
  | { ok: true; assignment: RoleAssignment }
  | { ok: false; status: number; error: string };

export type RevokeResult = { ok: true } | { ok: false; status: number; error: string };

function isKnownRole(roleId: string): boolean {
  return getBuiltInRoles().some((role) => role.id === roleId);
}

/** A per-site WordPress scope, e.g. `/wordpress/sites/blog` (matches wordpress-rbac). */
const WORDPRESS_SITE_SCOPE_RE = /^\/wordpress\/sites\/([a-z0-9][a-z0-9-]*[a-z0-9])$/;

/**
 * When a grant/revoke changes who is authorized for a specific WordPress site,
 * reconcile that site's Authentik access group so the SSO gate matches RBAC with no
 * manual Authentik step. Fire-and-forget and best-effort: the WordPress addon's SSO
 * reconcile and its manual "sync access" action also converge the group, so a
 * transient failure here is self-healing. A lazy dynamic import keeps core decoupled
 * from the addon. Broad grants (`/wordpress`, `/`) are intentionally NOT fanned out
 * to every site here — those converge via the addon's own reconcile — so core never
 * enumerates the cluster.
 */
function syncWordpressAccessForScope(scope: string): void {
  const match = WORDPRESS_SITE_SCOPE_RE.exec(scope);
  if (!match) return;
  const site = match[1];
  // Retry with backoff because a REVOKE that silently fails would leave a user
  // with access — access revocation is a security control, not best-effort. If
  // every attempt fails the admin can force it via
  // `POST /api/wordpress/sites/<site>/access`.
  void retryWithBackoff(
    `WordPress access sync for '${site}'`,
    async () => {
      const mod = await import("@/addons/wordpress-manager/lib/access");
      await mod.syncSiteAccess(site);
      // Best-effort follow-up: materialize the new grant set as WordPress
      // accounts with mapped roles. Deliberately fire-and-forget — the Authentik
      // reconcile above is the security control; this one re-runs on the next
      // access sync if the site's pod isn't running right now.
      void import("@/addons/wordpress-manager/lib/provision")
        .then((provision) => provision.syncSiteWpUsers(site))
        .catch((err) => console.warn(`[rbac] WordPress user sync for '${site}' skipped:`, errorMessage(err)));
    },
    undefined,
    "run access sync manually",
  ).catch(() => {});
}

/**
 * Fan a storage grant/revoke out to the share's Authentik access groups, so an
 * app that scopes its view by group — Nextcloud's external storage is the
 * motivating case — shows the folder to exactly the users InfraWeaver granted
 * it to. See lib/nas/access.ts.
 *
 * A grant on a broad scope (`/nas`, `/nas/<provider>`, `/`) covers many folders.
 * We never enumerate the appliances on this hot path; instead we reconcile the
 * scopes whose groups actually exist, which the registry records on every sync.
 */
function syncStorageAccessForScope(scope: string): void {
  const parsed = parseNasScope(scope);
  if (parsed) {
    // Reconciles the granted scope's groups and, for a folder, its share's groups
    // too — the pair an external-storage mount binds. See lib/nas/access.ts.
    // Retry with backoff for the same reason the WordPress reconcile does: a
    // REVOKE that silently fails would leave a user seeing a folder they no
    // longer have rights to. Revocation is a security control, not best-effort.
    const label = [parsed.provider, parsed.share, parsed.subfolder].filter(Boolean).join("/");
    void retryWithBackoff(
      `storage access sync for '${label}'`,
      async () => {
        const mod = await import("@/lib/nas/access");
        await mod.syncShareAccess(parsed.provider, parsed.share, parsed.subfolder);
      },
      undefined,
      "re-run it from the storage panel",
    ).catch(() => {});
    return;
  }

  // A scope that COVERS many folders: `/nas`, `/nas/<provider>`, or `/` (the
  // platform-owner grant, which puts its holder in every storage group). We
  // cannot enumerate the appliances on this hot path, but we do know every scope
  // whose groups were ever materialized, so reconcile exactly those.
  //
  // Skipping this is not cosmetic: revoking a broad grant would otherwise
  // reconcile nothing, leaving the user in the Authentik groups a previous sync
  // put them in — still seeing the folder in Nextcloud after their access was
  // taken away. Revocation is a security control, so same retry discipline.
  if (scope === ROOT_SCOPE || isNasScope(scope)) {
    void retryWithBackoff(
      `storage reconcile under '${scope}'`,
      async () => {
        const mod = await import("@/lib/nas/access");
        const reconciled = await mod.syncStorageScopesUnder(scope);
        if (reconciled.length > 0) {
          console.warn(`[rbac] reconciled ${reconciled.length} storage scope(s) under '${scope}'`);
        }
      },
      undefined,
      're-run "Sync access groups" on each affected folder',
    ).catch(() => {});
  }
}

/**
 * Provision or deprovision the LOCAL Jellyfin account behind a `/jellyfin` grant.
 *
 * Jellyfin's OIDC covers only its web UI; native and TV clients authenticate
 * against a local account, so "granting Jellyfin" has to materialize one. A
 * revoke disables it. `lib/jellyfin/access.ts` owns the retry and no-ops when
 * Jellyfin is not configured, so this stays a one-liner.
 */
function syncJellyfinAccessForScope(scope: string): void {
  void import("@/lib/jellyfin/access")
    .then((mod) => mod.reconcileJellyfinAccessWithRetry(scope))
    .catch((err) => console.warn("[rbac] Jellyfin access sync skipped:", errorMessage(err)));
}

/** Every downstream identity system a scope change can touch. */
function syncAccessForScope(scope: string): void {
  syncWordpressAccessForScope(scope);
  syncStorageAccessForScope(scope);
  syncJellyfinAccessForScope(scope);
}

function sameEffect(a?: "Allow" | "Deny", b?: "Allow" | "Deny"): boolean {
  return (a ?? "Allow") === (b ?? "Allow");
}

export async function grantRoleAssignment(
  input: GrantAssignmentInput,
  ctx: AssignmentActionContext,
): Promise<AssignmentActionResult> {
  const isGroup = input.principalType === "group";
  const result = await applyRoleAssignments(
    {
      principalType: input.principalType,
      principal: input.principal,
      grants: [{ roleId: input.roleId, scope: input.scope, expiresAt: input.expiresAt, effect: input.effect }],
      revokes: [],
    },
    ctx,
    {
      commitMessage: `rbac: grant ${input.roleId} to ${isGroup ? `group ${input.principal}` : input.principal} at ${input.scope}`,
      auditEvent: "rbac:assign",
      auditMessage: `Granted role '${input.roleId}' to ${isGroup ? `group '${input.principal}'` : `'${input.principal}'`} at scope '${input.scope}'`,
    },
  );
  if (!result.ok) {
    // Preserve the single-grant path's historical error strings.
    if (result.status === 400) return { ok: false, status: 400, error: "Unknown role" };
    if (result.status === 409) return { ok: false, status: 409, error: "Assignment already exists" };
    return result;
  }
  // The batch appends its minted grants, so the new assignment is the last one.
  return { ok: true, assignment: result.assignments[result.assignments.length - 1] };
}

/** A single addition in a batch apply — a grant with no id yet (minted here). */
export interface ApplyGrantDraft {
  roleId: string;
  scope: string;
  expiresAt?: string;
  effect?: "Allow" | "Deny";
}

/**
 * A batch of role-assignment changes for ONE principal, applied atomically:
 * every revoke and every grant lands in a SINGLE users.yaml load → ceiling
 * check → save, and (for a user principal) fires ONE change notification.
 *
 * This is what turns a role SWAP — the UI models it as "delete the old grant,
 * add the new one at the same scope" — into a single commit and a single
 * "your access was changed from X to Y" email, instead of the paired
 * revoke-then-grant that two separate calls produce (two commits, two emails).
 */
export interface ApplyAssignmentsInput {
  principalType: "user" | "group";
  /** Username (user principals) or Authentik group name (group principals). */
  principal: string;
  /** New assignments to add; each is minted with a fresh id. */
  grants: ApplyGrantDraft[];
  /** Ids of existing assignments on this principal to remove. */
  revokes: string[];
}

export type ApplyAssignmentsResult =
  | { ok: true; assignments: RoleAssignment[]; grantedCount: number; revokedCount: number }
  | { ok: false; status: number; error: string };

/**
 * Overrides for the git commit message and audit-log entry, so the single-delta
 * wrappers (`grantRoleAssignment`/`revokeRoleAssignment`) keep their historical
 * event names and messages while delegating to the batch implementation.
 */
interface ApplyAuditLabels {
  commitMessage: string;
  auditEvent: string;
  auditMessage: string;
}

/** Two assignments describe the same grant for the batch dedup check. */
function sameGrantKey(a: { roleId: string; scope: string; effect?: "Allow" | "Deny" }, b: ApplyGrantDraft): boolean {
  return a.roleId === b.roleId && a.scope === b.scope && sameEffect(a.effect, b.effect);
}

/**
 * Apply a batch of grants and revokes to a single principal in one write.
 *
 * Semantics are fail-closed and atomic: EVERY delta is validated up front
 * (unknown role → 400, privilege ceiling on each grant AND each revoke → 403,
 * a revoke id that isn't present → 404, a grant that duplicates what remains →
 * 409) and NOTHING is persisted unless all deltas pass. The privilege ceiling
 * is the same one `grantRoleAssignment`/`revokeRoleAssignment` enforce per call.
 *
 * The affected scopes are reconciled downstream (Authentik/Nextcloud/Jellyfin)
 * exactly as the single-delta paths do, and a user principal's change notice is
 * sent ONCE over the full before/after so a same-scope revoke+grant collapses
 * into one "changed" email. Group principals are not mailed (they fan out to
 * many members) — mirroring the single-delta paths.
 */
export async function applyRoleAssignments(
  rawInput: ApplyAssignmentsInput,
  ctx: AssignmentActionContext,
  labels?: ApplyAuditLabels,
): Promise<ApplyAssignmentsResult> {
  // Store-side invariant: a group principal is persisted verbatim as a
  // users.yaml key (`file.groups[principal]`). Trim it here — the single choke
  // point every write path (grant/revoke/batch) funnels through — so a
  // whitespace-padded " platform-admins" can never land as a distinct key that
  // no (already-trimmed) session group will ever match.
  const input: ApplyAssignmentsInput =
    rawInput.principalType === "group"
      ? { ...rawInput, principal: rawInput.principal.trim() }
      : rawInput;
  const isGroup = input.principalType === "group";

  // Reject unknown roles before touching git (matches grantRoleAssignment).
  for (const grant of input.grants) {
    if (!isKnownRole(grant.roleId)) return { ok: false, status: 400, error: `Unknown role '${grant.roleId}'` };
  }

  // Privilege ceiling on every grant, before any load/write (fail-closed).
  for (const grant of input.grants) {
    if (assignmentExceedsGranter(ctx.granterPermsAt(grant.scope), grant.roleId)) {
      await auditLog(
        "rbac:assign:denied",
        ctx.actor,
        `Denied granting role '${grant.roleId}' to ${input.principalType} '${input.principal}': exceeds granter permissions`,
      );
      return { ok: false, status: 403, error: "Cannot grant a role that exceeds your own permissions" };
    }
  }

  const file = await loadUsersConfig();

  const group = isGroup ? file.groups[input.principal] : undefined;
  const user = isGroup ? undefined : file.users[input.principal];
  if (!isGroup && !user) return { ok: false, status: 404, error: "User not found" };

  const before = isGroup
    ? normalizeGroupRoleAssignments(input.principal, group?.role_assignments)
    : normalizeRoleAssignments(input.principal, user!.role_assignments);

  // Resolve every revoke id and apply the revoke ceiling before writing.
  const revokeIds = new Set(input.revokes);
  const removed: RoleAssignment[] = [];
  for (const id of revokeIds) {
    const target = before.find((a) => a.id === id);
    if (!target) return { ok: false, status: 404, error: `Assignment '${id}' not found` };
    if (assignmentExceedsGranter(ctx.granterPermsAt(target.scope), target.roleId)) {
      await auditLog(
        "rbac:revoke:denied",
        ctx.actor,
        `Denied revoking assignment '${id}' (role '${target.roleId}') from ${input.principalType} '${input.principal}': exceeds revoker permissions`,
      );
      return { ok: false, status: 403, error: "Cannot revoke a role that exceeds your own permissions" };
    }
    removed.push(target);
  }

  const remaining = before.filter((a) => !revokeIds.has(a.id));

  // Dedup grants against what survives the revokes AND against each other, so a
  // batch can't add a duplicate or two identical grants at once.
  const added: RoleAssignment[] = [];
  for (const grant of input.grants) {
    const clashesRemaining = remaining.some((a) => sameGrantKey(a, grant));
    const clashesAdded = added.some((a) => sameGrantKey(a, grant));
    if (clashesRemaining || clashesAdded) {
      return { ok: false, status: 409, error: `Assignment for '${grant.roleId}' at '${grant.scope}' already exists` };
    }
    added.push({
      id: randomUUID(),
      roleId: grant.roleId,
      scope: grant.scope,
      principalType: input.principalType,
      principalId: input.principal,
      grantedBy: ctx.actor,
      grantedAt: new Date().toISOString(),
      ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
      ...(grant.effect ? { effect: grant.effect } : {}),
    });
  }

  // Nothing to do: don't write an empty commit or send an empty notice.
  if (removed.length === 0 && added.length === 0) {
    return { ok: true, assignments: before, grantedCount: 0, revokedCount: 0 };
  }

  const after = [...remaining, ...added];
  const summary = `${added.length} grant(s), ${removed.length} revoke(s)`;
  const commitMessage =
    labels?.commitMessage ?? `rbac: apply ${summary} to ${isGroup ? `group ${input.principal}` : input.principal}`;

  if (isGroup) {
    const nextGroups = { ...file.groups, [input.principal]: { ...(group ?? {}), role_assignments: after } };
    await saveUsersConfig(file.users, file.sha, commitMessage, nextGroups);
  } else {
    file.users[input.principal] = { ...user!, role_assignments: after };
    await saveUsersConfig(file.users, file.sha, commitMessage, file.groups);
  }

  await auditLog(
    labels?.auditEvent ?? "rbac:assign:batch",
    ctx.actor,
    labels?.auditMessage ?? `Applied ${summary} to ${input.principalType} '${input.principal}'`,
  );

  // Reconcile every scope a delta touched, exactly once each.
  for (const scope of new Set([...added, ...removed].map((a) => a.scope))) {
    syncAccessForScope(scope);
  }

  // One change notice over the full before/after: a same-scope revoke+grant
  // reads as a single "changed" line, not a paired revoke + grant.
  if (!isGroup) notifyRbacChange(input.principal, before, after);

  return { ok: true, assignments: after, grantedCount: added.length, revokedCount: removed.length };
}

export interface RevokeAssignmentInput {
  assignmentId: string;
  principalType: "user" | "group";
  /** Username (user principals) or group name (group principals). */
  principal: string;
}

/**
 * Revoke one assignment. The privilege ceiling mirrors the grant ceiling:
 * revoking an assignment whose role confers permissions the revoker lacks is
 * denied — whether it is an Allow (revoking it is a lockout / denial-of-service,
 * e.g. removing an Owner "*") or a Deny (stripping it restores those permissions
 * to the target, i.e. escalation). `applyRoleAssignments` enforces exactly that.
 */
export async function revokeRoleAssignment(input: RevokeAssignmentInput, ctx: AssignmentActionContext): Promise<RevokeResult> {
  const isGroup = input.principalType === "group";
  const result = await applyRoleAssignments(
    { principalType: input.principalType, principal: input.principal, grants: [], revokes: [input.assignmentId] },
    ctx,
    {
      commitMessage: `rbac: revoke assignment ${input.assignmentId} from ${isGroup ? `group ${input.principal}` : input.principal}`,
      auditEvent: "rbac:revoke",
      auditMessage: `Revoked assignment '${input.assignmentId}' from ${isGroup ? `group '${input.principal}'` : `'${input.principal}'`}`,
    },
  );
  if (!result.ok) {
    // Preserve the single-revoke path's historical error strings ("User not
    // found" passes through; the batch's id-specific 404 becomes the generic one).
    if (result.status === 404 && result.error !== "User not found") {
      return { ok: false, status: 404, error: "Assignment not found" };
    }
    return result;
  }
  return { ok: true };
}
