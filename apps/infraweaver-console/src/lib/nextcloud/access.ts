/**
 * Server-side wiring for Nextcloud LOCAL credentials — the Nextcloud analogue of
 * `lib/jellyfin/access.ts`'s reset path.
 *
 * Why a Nextcloud has local passwords at all
 * ------------------------------------------
 * Nextcloud sign-in is OIDC/SSO through Authentik, and folder visibility follows
 * Authentik group membership (see `lib/nas/access.ts`) — the browser never needs a
 * local password. But native/WebDAV clients (mobile sync, `davfs`, backup tooling)
 * cannot do the OIDC dance and need a local username+password, exactly like Jellyfin's
 * native clients. When the platform mints one, it is persisted to OpenBao so the owner
 * can reveal it later for a new client instead of resetting — and reset stays available
 * as the admin recovery when a stored credential is lost.
 *
 * Unlike Jellyfin there is no reconcile/roster: Nextcloud accounts are provisioned by
 * OIDC on first login, not by this console. The "is this ours to touch" signal is
 * therefore the account's own existence in Nextcloud, plus a hard refusal to ever
 * reset the platform admin account (the OCS credential's own identity).
 */
import "server-only";
import { loadUsersConfig } from "@/lib/users-config";
import { generateAppPassword } from "@/lib/app-accounts/password";
import { openBaoAppAccountStore } from "@/lib/app-accounts/store";
import { NEXTCLOUD_APP_ID, nextcloudAdmin, nextcloudLaunchUrl } from "@/lib/nextcloud/config";
import { nextcloudUserExists, setNextcloudUserPassword } from "@/lib/nextcloud/client";

/** Case-insensitive username key, matching Nextcloud's own user-id handling. */
function usernameKey(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * The credential a reset hands back to the operator for an out-of-band hand-off.
 * Identical shape to a Jellyfin reset so the panel renders it with the same card.
 */
export interface NextcloudResetResult {
  username: string;
  password: string;
  launchUrl: string;
}

/**
 * Thrown when a reset targets a name Nextcloud does not know. A distinct type so the
 * route answers 404 for this expected refusal instead of masking it as a 500 — keeping
 * a genuine fault (Nextcloud down, vault down) legible as the real 500 it is.
 */
export class UnmanagedNextcloudAccountError extends Error {
  constructor(username: string) {
    super(`'${username}' is not a Nextcloud account`);
    this.name = "UnmanagedNextcloudAccountError";
  }
}

/**
 * Thrown when a reset targets the platform's own Nextcloud admin account. Resetting the
 * credential the console authenticates OCS with would be an own-goal (and lock the
 * console out), so it is refused outright — the Nextcloud counterpart to Jellyfin never
 * resetting its service account.
 */
export class ProtectedNextcloudAccountError extends Error {
  constructor(username: string) {
    super(`'${username}' is the platform Nextcloud admin account and cannot be reset here`);
    this.name = "ProtectedNextcloudAccountError";
  }
}

/**
 * Reset one Nextcloud user's LOCAL password, persist it for reveal, and hand it back
 * once for an out-of-band hand-off. Mints a fresh strong password, sets it on the
 * server over OCS, and stores it in OpenBao (`secret/platform/app-accounts/nextcloud/
 * users/<name>`) so it can be revealed later without another reset.
 *
 * Refuses the platform admin account and refuses a name Nextcloud does not have — this
 * console only ever (re)sets local passwords for accounts that already exist, it never
 * fabricates one. The plaintext lives only in this scope and the store; it is returned
 * to the authenticated admin caller and never logged.
 */
export async function resetNextcloudCredential(username: string): Promise<NextcloudResetResult> {
  const admin = nextcloudAdmin();
  if (admin && usernameKey(admin.user) === usernameKey(username)) {
    throw new ProtectedNextcloudAccountError(username);
  }

  if (!(await nextcloudUserExists(username))) {
    throw new UnmanagedNextcloudAccountError(username);
  }

  const password = generateAppPassword();
  await setNextcloudUserPassword(username, password);

  await openBaoAppAccountStore.writeCredential(NEXTCLOUD_APP_ID, username, password, await resolveEmail(username));
  return { username, password, launchUrl: nextcloudLaunchUrl() };
}

/** Best-effort email for the credential record; reveal only ever returns user+pass. */
async function resolveEmail(username: string): Promise<string> {
  const cfg = await loadUsersConfig();
  const match = Object.entries(cfg.users).find(([name]) => usernameKey(name) === usernameKey(username));
  return match?.[1]?.email ?? "";
}
