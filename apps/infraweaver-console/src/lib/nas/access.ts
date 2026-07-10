/**
 * Server-side orchestration of a storage location's Authentik access groups.
 *
 * Why a group at all
 * ------------------
 * A grant in InfraWeaver decides who may *browse and mount* a folder from the
 * console. It says nothing, by itself, about who sees that folder inside the app
 * the folder is mounted into. Nextcloud is the case that matters: it provisions
 * groups from the OIDC `groups` claim on every login, and its external-storage
 * mounts are scoped with `files_external:applicable --add-group`. A mount with
 * no group applies to EVERY user.
 *
 * So each storage scope gets two Authentik groups — `…-ro` and `…-rw` — whose
 * membership is reconciled from the same RBAC facts the folder ACL reads. Bind
 * the Nextcloud mount to those names and "who sees /Media in Files" is exactly
 * "who InfraWeaver granted read-write on that folder", with no manual Nextcloud
 * step and no second source of truth.
 *
 * Which groups a mount should bind
 * --------------------------------
 * Bind BOTH the mounted folder's group and its share's group. Each group's
 * membership already includes everyone who inherits the permission from an
 * ancestor scope, so either is a complete answer for its own scope — but a
 * grant made at the share only triggers a reconcile of the SHARE group, and a
 * grant made at the folder only reconciles the FOLDER group. Binding both means
 * a grant at either scope takes effect immediately. Broader grants (`/nas`,
 * `/nas/<provider>`) reconcile neither and converge on the next explicit sync.
 *
 * Membership is a superset relation: `…-rw` ⊆ `…-ro`, because
 * `storage-contributor` carries `nas:read` as well as `nas:write`.
 */
import "server-only";
import { loadUsersConfig } from "@/lib/users-config";
import { syncAppAccessMembers, removeAppAccessGroup, type AccessSyncResult } from "@/lib/sso/access";
import { computeShareAccessUsers, storageAccessGroupName } from "@/lib/nas/access-policy";
import { nasFolderScope, parseNasScope } from "@/lib/nas/scope";
import { scopeCovers } from "@/lib/rbac";
import { readSyncedStorageScopes, recordSyncedStorageScope } from "@/lib/nas/store";
import type { NasAccess } from "@/lib/nas/folder-acl";

export { storageAccessGroupName };

export interface ShareAccessSyncResult {
  readonly: AccessSyncResult;
  readwrite: AccessSyncResult;
  /** The Authentik group names reconciled, for display and for binding a mount. */
  groups: { readonly: string; readwrite: string };
}

/** The usernames InfraWeaver currently authorizes on this location at `access`. */
export async function listShareAccessUsers(
  provider: string,
  share: string,
  access: NasAccess,
  subfolder = "",
): Promise<string[]> {
  const cfg = await loadUsersConfig();
  return computeShareAccessUsers(provider, share, access, cfg.users, cfg.groups, subfolder);
}

/**
 * Reconcile both access groups for one storage scope to their current
 * RBAC-derived membership. Idempotent; safe to call on every grant and revoke.
 */
export async function syncScopeAccess(
  provider: string,
  share: string,
  subfolder = "",
): Promise<ShareAccessSyncResult> {
  const cfg = await loadUsersConfig();
  const readers = computeShareAccessUsers(provider, share, "readonly", cfg.users, cfg.groups, subfolder);
  const writers = computeShareAccessUsers(provider, share, "readwrite", cfg.users, cfg.groups, subfolder);
  const groups = {
    readonly: storageAccessGroupName(provider, share, "readonly", subfolder),
    readwrite: storageAccessGroupName(provider, share, "readwrite", subfolder),
  };
  const result: ShareAccessSyncResult = {
    readonly: await syncAppAccessMembers(groups.readonly, readers),
    readwrite: await syncAppAccessMembers(groups.readwrite, writers),
    groups,
  };

  // Remember that this scope now has materialized groups. A later grant or revoke
  // on a scope that merely COVERS it (`/nas`, `/nas/<provider>`, `/`) cannot
  // enumerate the appliance, so it reconciles this list instead. Best-effort: a
  // failed bookkeeping write must not fail an otherwise successful reconcile.
  try {
    await recordSyncedStorageScope(nasFolderScope(provider, share, subfolder));
  } catch (error) {
    console.warn("[nas] could not record synced storage scope:", error instanceof Error ? error.message : error);
  }

  return result;
}

/**
 * Reconcile the groups for a folder AND for the share that contains it — the
 * pair a mount should bind. Returns the folder's result (the share's is a
 * side-effect) so the caller can report the group names it just converged.
 */
export async function syncShareAccess(
  provider: string,
  share: string,
  subfolder = "",
): Promise<ShareAccessSyncResult> {
  const atScope = await syncScopeAccess(provider, share, subfolder);
  if (subfolder) await syncScopeAccess(provider, share, "");
  return atScope;
}

/**
 * Reconcile every scope with materialized groups that `changedScope` covers.
 *
 * The escape hatch for broad grants. Granting or revoking `storage-contributor`
 * at `/nas/truenas` changes membership of every group beneath it, but the
 * grant path cannot enumerate the appliance's shares. It reconciles the recorded
 * scopes instead — which is exactly the set of groups that actually exist.
 */
export async function syncStorageScopesUnder(changedScope: string): Promise<string[]> {
  const scopes = await readSyncedStorageScopes();
  const covered = scopes.filter((scope) => scopeCovers(changedScope, scope));
  for (const scope of covered) {
    const parsed = parseNasScope(scope);
    if (!parsed) continue;
    await syncScopeAccess(parsed.provider, parsed.share, parsed.subfolder);
  }
  return covered;
}

/** Tear down a scope's access groups. Idempotent. */
export async function removeShareAccess(provider: string, share: string, subfolder = ""): Promise<void> {
  await removeAppAccessGroup(storageAccessGroupName(provider, share, "readonly", subfolder));
  await removeAppAccessGroup(storageAccessGroupName(provider, share, "readwrite", subfolder));
}
