/**
 * Proactive Nextcloud account provisioning — SERVER ONLY.
 *
 * Why this exists
 * ---------------
 * Nextcloud accounts are JIT-provisioned by OIDC on first browser login, and folder
 * visibility follows the `nc_groups` claim. That is enough for a person who signs in
 * through the web — but it leaves a gap the reconcile loop must close: right after a
 * user enrolls, their Nextcloud account does NOT yet exist, so a WebDAV/native client
 * (or an operator proving `/Media` access) has nothing to authenticate against, and
 * the credential reveal has nothing to reveal. The person would have to open the
 * Nextcloud web UI once before anything else worked.
 *
 * So the reconcile loop calls this for every ENROLLED user who holds a storage grant:
 * it materializes the Database-backend account immediately, in exactly the storage
 * groups their RBAC grants confer, and persists a local password to OpenBao for later
 * reveal. The uid is the console username (== the OIDC `preferred_username`), so a
 * later SSO login resolves to this same identity instead of forking a second account.
 *
 * Everything here is idempotent: an account already present (JIT or a prior tick) is
 * left as-is (its password is NOT reset — that would break existing native clients),
 * and only its group membership is re-ensured.
 */
import "server-only";
import { generateAppPassword } from "@/lib/app-accounts/password";
import { openBaoAppAccountStore } from "@/lib/app-accounts/store";
import { NEXTCLOUD_APP_ID } from "@/lib/nextcloud/config";
import {
  addNextcloudUserToGroup,
  createNextcloudUser,
  ensureNextcloudGroup,
  nextcloudUserExists,
} from "@/lib/nextcloud/client";

export interface NextcloudProvisionResult {
  username: string;
  /** True when this run created the account; false when it already existed. */
  created: boolean;
  /** Storage groups the account was placed in (idempotent membership). */
  groups: string[];
}

/**
 * Ensure a Nextcloud account exists for `username` and belongs to `groups`.
 *
 * - Absent account → create a Database-backend user with a generated local password,
 *   persisted to OpenBao (`secret/platform/app-accounts/nextcloud/users/<name>`) so it
 *   can be revealed later without a reset.
 * - Present account (JIT-provisioned or created on an earlier tick) → left intact;
 *   only group membership is re-ensured. The password is never reset here.
 *
 * `groups` are the Authentik-derived storage group names (e.g.
 * `storage-truenas-infraweaver-media-<hash>-rw`) that the `/Media` mount binds to;
 * each is created in Nextcloud if missing, then the user is added. Group work is
 * best-effort per group so one bad name never aborts the account provisioning.
 */
export async function ensureNextcloudUserProvisioned(input: {
  username: string;
  email?: string;
  displayName?: string;
  groups: readonly string[];
}): Promise<NextcloudProvisionResult> {
  const { username, email, displayName, groups } = input;

  let created = false;
  if (!(await nextcloudUserExists(username))) {
    const password = generateAppPassword();
    const result = await createNextcloudUser({ userid: username, password, email, displayName });
    created = result.created;
    if (created) {
      // Persist for later reveal (native/WebDAV clients that can't do OIDC). Best-effort:
      // a store failure must not undo a successful account creation.
      try {
        await openBaoAppAccountStore.writeCredential(NEXTCLOUD_APP_ID, username, password, email ?? "");
      } catch {
        // swallowed — the account exists; reset can re-mint and re-store a credential.
      }
    }
  }

  const placed: string[] = [];
  for (const group of groups) {
    try {
      await ensureNextcloudGroup(group);
      await addNextcloudUserToGroup(username, group);
      placed.push(group);
    } catch {
      // One unbindable group must not fail the others (or the whole reconcile tick).
    }
  }

  return { username, created, groups: placed };
}
