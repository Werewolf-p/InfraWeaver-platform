/**
 * Server-side wiring: InfraWeaver RBAC → real Jellyfin local accounts.
 *
 * Ties the pure policy (`lib/app-accounts/policy`) and the generic engine
 * (`lib/app-accounts/reconcile`) to the Jellyfin adapter, the OpenBao store, and
 * the default notifier. This is the Jellyfin analogue of the WordPress addon's
 * `provision.ts#syncSiteWpUsers` and its `access.ts`.
 *
 * Scope model
 * -----------
 * Jellyfin is a single instance, so it gets one top-level RBAC scope, `/jellyfin`,
 * matching the per-resource pattern (`/wordpress/...`, `/game-hub/...`, `/nas/...`).
 * A grant on `/jellyfin` (or an ancestor like `/`) authorizes an account; the app
 * `admin` verb maps to a Jellyfin administrator, everything else to a standard user.
 */
import "server-only";
import { auditLog } from "@/lib/audit-log";
import { DEFAULT_RETRY_DELAYS_MS, retryWithBackoff } from "@/lib/retry";
import { loadUsersConfig } from "@/lib/users-config";
import { computeDesiredAppUsers } from "@/lib/app-accounts/policy";
import { generateAppPassword } from "@/lib/app-accounts/password";
import { syncAppUsers, deprovisionAppUser, type AppUserSyncSummary, type DeprovisionResult } from "@/lib/app-accounts/reconcile";
import { openBaoAppAccountStore } from "@/lib/app-accounts/store";
import { consoleAccountNotifier } from "@/lib/app-accounts/notify";
import type { AppPermissionPair, DesiredAppUser } from "@/lib/app-accounts/types";
import { resolveAuthentikIdentity } from "@/lib/users/resolve-identity";
import { JELLYFIN_APP_ID, jellyfinLaunchUrl } from "@/lib/jellyfin/config";
import { JellyfinAccountProvider } from "@/lib/jellyfin/provider";

/** The single RBAC scope that governs Jellyfin access. */
export const JELLYFIN_SCOPE = "/jellyfin";

/**
 * Jellyfin's read/admin permission pair.
 *
 * `jellyfin:read` / `jellyfin:admin` are added to the `Permission` union and to the
 * built-in roles by the reported rbac.ts edit (see docs/app-account-provisioning.md).
 * The cast is confined to this one place so the rest of the module stays fully typed;
 * until the edit lands these simply grant nobody (isAllowed → false), so the feature
 * is inert rather than mis-authorizing. Delete the casts once the union carries them.
 */
export const JELLYFIN_PERMISSIONS: AppPermissionPair = {
  read: "jellyfin:read",
  admin: "jellyfin:admin",
};

/** True when a scope change touches Jellyfin (the scope itself or an ancestor). */
export function isJellyfinScope(scope: string): boolean {
  return scope === "/" || scope === JELLYFIN_SCOPE || scope.startsWith(`${JELLYFIN_SCOPE}/`);
}

/**
 * Materialize the current RBAC grants as Jellyfin local accounts: everyone with
 * `jellyfin:read` at `/jellyfin` who has ALSO enrolled in Authentik gets an account
 * (admins mapped to Jellyfin administrators), newly-authorized users get a random
 * password + a credential notification, and revoked users are disabled. Idempotent.
 *
 * Enrollment gate: a Jellyfin account is created only AFTER the person's Authentik
 * SSO identity exists, and it is keyed by the CANONICAL Authentik username (the name
 * the user chose at enrollment) — never the users.yaml key, which can drift. This is
 * what keeps the Jellyfin login identical to the SSO login instead of a confusing
 * second name. A user with a Jellyfin grant but no Authentik identity yet is deferred
 * to a later tick (the reconcile re-runs after they enroll).
 */
export async function syncJellyfinUsers(): Promise<AppUserSyncSummary> {
  const cfg = await loadUsersConfig();
  const desired = computeDesiredAppUsers(
    JELLYFIN_SCOPE,
    JELLYFIN_PERMISSIONS.read,
    JELLYFIN_PERMISSIONS.admin,
    cfg.users,
    cfg.groups,
  );

  // Existing managed accounts. A user already on the roster is, by construction,
  // already enrolled — keep them in the desired set even if the Authentik lookup
  // below transiently misses (a 5xx/timeout collapses to null), so an Authentik blip
  // can never false-revoke a working account. Genuinely revoked users have no grant
  // and so never reach this loop; syncAppUsers still disables them via the roster diff.
  const roster = await openBaoAppAccountStore.loadRoster(JELLYFIN_APP_ID);
  const provisioned = new Set(roster.map((e) => usernameKey(e.username)));

  const gated: DesiredAppUser[] = [];
  for (const u of desired.users) {
    const identity = await resolveAuthentikIdentity(u.username, u.email);
    if (identity) {
      const canonical =
        typeof identity.username === "string" && identity.username ? identity.username : u.username;
      gated.push({ ...u, username: canonical });
    } else if (provisioned.has(usernameKey(u.username))) {
      gated.push(u); // already provisioned (thus enrolled); keep to avoid false-revoke
    }
    // else: grant present but not enrolled yet and no account — defer to a later tick.
  }

  return syncAppUsers(
    new JellyfinAccountProvider(),
    { users: gated, skippedNoEmail: desired.skippedNoEmail },
    { store: openBaoAppAccountStore, notifier: consoleAccountNotifier },
  );
}

/**
 * Offboard one user from Jellyfin: delete the local account and clear its roster row +
 * stored credential. The offboard-time counterpart to {@link syncJellyfinUsers}, which
 * only ever disables a revoked account. Idempotent — a user with no Jellyfin account is
 * a no-op success. Delegates to the generic engine so the Jellyfin specifics stay in the
 * adapter.
 */
export async function offboardJellyfinUser(username: string): Promise<DeprovisionResult> {
  return deprovisionAppUser(new JellyfinAccountProvider(), username, openBaoAppAccountStore);
}

/** Case-insensitive username key, matching the reconcile engine and Jellyfin itself. */
function usernameKey(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * The credential a reset hands back to the operator for an out-of-band hand-off.
 * Identical shape to a reveal, so the panel renders it with the same card.
 */
export interface JellyfinResetResult {
  username: string;
  password: string;
  launchUrl: string;
}

/**
 * Thrown when a reset targets a name InfraWeaver does not manage. A distinct type so
 * the route answers 404 for this expected refusal instead of masking it as a 500 —
 * keeping a genuine fault (Jellyfin down, vault down) legible as the real 500 it is.
 */
export class UnmanagedJellyfinAccountError extends Error {
  constructor(username: string) {
    super(`'${username}' is not an InfraWeaver-managed Jellyfin account`);
    this.name = "UnmanagedJellyfinAccountError";
  }
}

/**
 * Explicitly reset one MANAGED Jellyfin account's password. This is the audited admin
 * action that makes an ADOPTED account usable again — adoption re-rosters an orphan
 * but cannot recover its lost password, so the credential is unknown until this runs —
 * and doubles as the "reset a user's Jellyfin password" recovery.
 *
 * Restricted to accounts on the roster: InfraWeaver resets only passwords it manages,
 * never a manual or app-native account (resetting the operator's personal Jellyfin
 * admin would be an own-goal). The new password is minted here, set on the server,
 * persisted for reveal, and the hand-off recorded (`markNotified`) so the account
 * stops surfacing as adopted/pending. The plaintext lives only in this scope and the
 * store; it is returned to the authenticated admin caller and never logged.
 */
export async function resetJellyfinCredential(username: string): Promise<JellyfinResetResult> {
  const roster = await openBaoAppAccountStore.loadRoster(JELLYFIN_APP_ID);
  const entry = roster.find((e) => usernameKey(e.username) === usernameKey(username));
  if (!entry) throw new UnmanagedJellyfinAccountError(username);

  const provider = new JellyfinAccountProvider();
  await provider.ensureServiceAccount();
  const password = generateAppPassword();
  await provider.resetPassword(entry.providerUserId, password);

  await openBaoAppAccountStore.writeCredential(JELLYFIN_APP_ID, entry.username, password, await resolveEmail(entry.username));
  await openBaoAppAccountStore.markNotified(JELLYFIN_APP_ID, entry.username, new Date().toISOString());
  return { username: entry.username, password, launchUrl: jellyfinLaunchUrl() };
}

/** Best-effort email for the credential record; reveal only ever returns user+pass. */
async function resolveEmail(username: string): Promise<string> {
  const cfg = await loadUsersConfig();
  const match = Object.entries(cfg.users).find(([name]) => usernameKey(name) === usernameKey(username));
  return match?.[1]?.email ?? "";
}

/**
 * Fan a grant/revoke on a Jellyfin-covering scope out to the real accounts, with
 * backoff (the shared `retryWithBackoff` cadence, same as the WordPress/NAS access
 * reconciles) — for the same reason storage does: a REVOKE that silently failed
 * would leave a disabled-in-intent user still able to log in. Revocation is a
 * security control, not best-effort. Called (fire-and-forget) from
 * `syncAccessForScope` in `lib/rbac-assignments.ts` via a lazy import (see the
 * reported edit). Broad scopes (`/`) are handled here too, since Jellyfin is a
 * single instance — no fan-out explosion to guard against, unlike per-share storage.
 *
 * Exhausting the retries is a security event, not a log line: the caller is
 * fire-and-forget, so a terminal failure is the ONLY record that a revoked user may
 * still hold a working Jellyfin login. It goes to the audit log, where a failed
 * revocation is reviewable, rather than only to stderr.
 */
export async function reconcileJellyfinAccessWithRetry(scope: string): Promise<void> {
  if (!isJellyfinScope(scope)) return;
  try {
    await retryWithBackoff(
      `Jellyfin account sync for '${scope}'`,
      () => syncJellyfinUsers(),
      DEFAULT_RETRY_DELAYS_MS,
      "run it from the Jellyfin access panel",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await auditLog(
      "jellyfin:access-sync",
      "system",
      `Jellyfin account sync for scope '${scope}' failed after ${DEFAULT_RETRY_DELAYS_MS.length + 1} attempts; a revoked user may retain a working local login. Re-run it from the Jellyfin access panel. Last error: ${message}`,
      { result: "failure", resource: scope },
    );
  }
}
