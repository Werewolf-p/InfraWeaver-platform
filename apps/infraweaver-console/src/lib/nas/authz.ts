/**
 * Scope-aware authorization for the NAS routes.
 *
 * The problem this solves
 * ----------------------
 * Every NAS route used to gate on `hasSessionPermission(rbac, "nas:read")` —
 * which evaluates at the ROOT scope. A user granted storage access on exactly
 * one share therefore held `nas:read` at `/nas/<provider>/<share>` and nowhere
 * else, so the guard rejected them at the door and the folder ACL never ran.
 * Scoped storage access was structurally impossible; the only way to express it
 * was the deploy-time `NAS_FOLDER_ACL_JSON` env var.
 *
 * The guards below instead ask "does the caller hold this permission ANYWHERE in
 * the `/nas` subtree?" to decide admission, and then every share/folder the
 * response would reveal or mutate is checked individually with
 * {@link nasAccessDecision}. Admission is coarse; the answer is precise.
 */
import "server-only";
import { hasAssignedPermissionInScopeTree, type Permission } from "@/lib/rbac";
import {
  getSessionEffectivePermissions,
  hasSessionPermission,
  type SessionRBACContext,
} from "@/lib/session-rbac";
import { evaluateFolderAcl, type FolderAclDecision, type NasAccess } from "@/lib/nas/folder-acl";
import { NAS_SCOPE_ROOT, nasAuthorizationScope } from "@/lib/nas/scope";

export interface NasTarget {
  provider: string;
  share: string;
  /** Share-relative folder; "" addresses the share root. */
  subfolder: string;
  access: NasAccess;
}

/**
 * True when the caller holds `permission` at the root scope (platform owner or
 * admin) or on ANY scope inside `/nas`. This is an admission check only: it says
 * the caller has *some* business with storage, not that they may touch a given
 * folder. Always follow it with {@link nasAccessDecision} per folder.
 */
function holdsNasPermissionAnywhere(rbac: SessionRBACContext, permission: Permission): boolean {
  if (hasSessionPermission(rbac, permission)) return true;
  return hasAssignedPermissionInScopeTree(rbac.roleAssignments, permission, NAS_SCOPE_ROOT);
}

/** May the caller reach the storage read APIs at all? */
export function canReadStorage(rbac: SessionRBACContext): boolean {
  return holdsNasPermissionAnywhere(rbac, "nas:read") || holdsNasPermissionAnywhere(rbac, "nas:write");
}

/** May the caller reach the storage write APIs at all? */
export function canWriteStorage(rbac: SessionRBACContext): boolean {
  return holdsNasPermissionAnywhere(rbac, "nas:write");
}

/**
 * The authoritative per-folder decision: owner bypass, then scoped RBAC grants,
 * then the legacy env ACL. `permissions` is deliberately the effective set at the
 * ROOT scope — `evaluateFolderAcl` uses its emptiness to tell a scope-granted
 * user (default-deny outside their grants) from a blanket `nas:*` holder.
 */
export function nasAccessDecision(rbac: SessionRBACContext, target: NasTarget): FolderAclDecision {
  return evaluateFolderAcl({
    username: rbac.username,
    groups: rbac.groups,
    permissions: [...getSessionEffectivePermissions(rbac)],
    roleAssignments: rbac.roleAssignments,
    provider: target.provider,
    share: target.share,
    subfolder: target.subfolder,
    access: target.access,
  });
}

/** Convenience: allowed-or-not, discarding the reason. */
export function canAccessNasFolder(rbac: SessionRBACContext, target: NasTarget): boolean {
  return nasAccessDecision(rbac, target).allowed;
}

/**
 * Narrow a folder listing to the entries the caller may at least read.
 *
 * A caller granted only `<share>/movies` must still be able to *traverse* the
 * share root to reach it, so the parent listing is allowed to run; this filter
 * then hides the siblings they cannot read.
 */
export function visibleFolders<T extends { name: string }>(
  rbac: SessionRBACContext,
  provider: string,
  share: string,
  parentSubfolder: string,
  folders: readonly T[],
): T[] {
  const prefix = parentSubfolder ? `${parentSubfolder.replace(/\/+$/, "")}/` : "";
  return folders.filter((entry) =>
    canAccessNasFolder(rbac, { provider, share, subfolder: `${prefix}${entry.name}`, access: "readonly" }),
  );
}

/**
 * May the caller *traverse* into `subfolder` to list its children? True when they
 * can read the folder itself, or when they hold a grant on something beneath it
 * (a grant on `media/movies` implies the right to open `media` to get there).
 */
export function canTraverseNasFolder(rbac: SessionRBACContext, target: Omit<NasTarget, "access">): boolean {
  if (canAccessNasFolder(rbac, { ...target, access: "readonly" })) return true;
  // Not readable here, but a grant somewhere BENEATH this folder implies the
  // right to open it on the way down. `scopesOverlap` (inside
  // hasAssignedPermissionInScopeTree) matches in both directions, so a grant on
  // `…/media/movies` permits traversing `…/media`.
  let prefix: string;
  try {
    prefix = nasAuthorizationScope(target.provider, target.share, target.subfolder);
  } catch {
    return false;
  }
  return (
    hasAssignedPermissionInScopeTree(rbac.roleAssignments, "nas:read", prefix)
    || hasAssignedPermissionInScopeTree(rbac.roleAssignments, "nas:write", prefix)
  );
}
