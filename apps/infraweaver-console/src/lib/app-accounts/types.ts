/**
 * App-account provisioning — the app-agnostic contracts.
 *
 * Why this exists
 * ---------------
 * Some apps InfraWeaver fronts only speak OIDC in their *web* UI. Jellyfin is
 * the motivating case: its native/TV clients (iOS, Android, tvOS, Roku…) sign in
 * with a LOCAL Jellyfin username + password, not SSO, so an Authentik access
 * group alone (the WordPress/NAS model) can never onboard those users.
 *
 * For apps like that, "granted in InfraWeaver RBAC" has to materialize as a real
 * LOCAL account in the app. This module is the reusable engine for that, mirroring
 * the WordPress addon's `syncSiteWpUsers` and the NAS access reconcile, but for
 * apps reached over an admin API rather than a pod exec or an Authentik group.
 *
 * The split (deliberate, so a second app is a new adapter, not a fork):
 *   - {@link AppAccountProvider}  — the ONLY app-specific surface. One file per app.
 *   - policy.ts / plan.ts / password.ts — pure, app-agnostic, unit-tested with no I/O.
 *   - reconcile.ts — the generic engine, given a provider + store + notifier.
 *   - store.ts / notify.ts — the durable roster/credential state and the delivery hook.
 */
import type { Permission } from "@/lib/rbac";

/** The two access levels the engine maps an RBAC grant onto. Apps translate these
 *  to their own model (Jellyfin: admin → IsAdministrator, user → standard). */
export type AppUserRole = "user" | "admin";

/** One account as it exists in the target app, projected to what the engine needs. */
export interface AppUserAccount {
  /** Provider-native, stable id (e.g. a Jellyfin user GUID). */
  id: string;
  username: string;
  role: AppUserRole;
  /** True when the account is present but login-disabled (our revocation state). */
  disabled: boolean;
}

/** An account InfraWeaver *wants* to exist, derived purely from RBAC. */
export interface DesiredAppUser {
  username: string;
  /** Required: an account we cannot reach the person at is one we won't email a
   *  credential to. Users with no email on record are reported, not provisioned. */
  email: string;
  role: AppUserRole;
}

export interface DesiredAppUsers {
  users: DesiredAppUser[];
  /** Authorized users skipped because users.yaml has no email to deliver creds to. */
  skippedNoEmail: string[];
}

/**
 * The only app-specific surface. An adapter is one file implementing this; the
 * engine never learns anything else about the app. Every method is expected to be
 * idempotent where it can be (ensureServiceAccount, setUserRole, disable/enable).
 */
export interface AppAccountProvider {
  /** Stable slug — namespaces the OpenBao roster/credentials and notifications. */
  readonly appId: string;
  /** Human label for notifications and audit lines (e.g. "Jellyfin"). */
  readonly appLabel: string;
  /** The URL a provisioned user should open to sign in (goes in their notification). */
  readonly launchUrl: string;
  /** Local username of the managed service account — never provisioned or disabled. */
  readonly serviceAccountUsername: string;

  /** Ensure the InfraWeaver service account + admin credential exist and are usable.
   *  Idempotent; called before every reconcile so a fresh install self-bootstraps. */
  ensureServiceAccount(): Promise<void>;
  /** Every account currently in the app (managed, manual, and the service account). */
  listUsers(): Promise<AppUserAccount[]>;
  /** Create a local account with the given password. Returns the created account. */
  createUser(username: string, password: string): Promise<AppUserAccount>;
  /** Converge an account's role (admin vs standard user). */
  setUserRole(id: string, role: AppUserRole): Promise<void>;
  /** Disable login for an account — the revoke action (retained, not deleted). */
  disableUser(id: string): Promise<void>;
  /** Re-enable a previously-disabled account — the re-grant action. */
  enableUser(id: string): Promise<void>;
  /**
   * Permanently delete an account. The reconcile engine never calls this — a revoke
   * disables, it does not delete — but offboard does: a departing user's local login
   * must be removed outright, not merely disabled. See {@link deprovisionAppUser}.
   */
  deleteUser(id: string): Promise<void>;
  /**
   * Reset an account's password to `password` as admin (no current password needed).
   * The reconcile engine never calls this — a sync must never silently rewrite a
   * credential — but an ADOPTED account's password is unknown until an explicit admin
   * reset runs it. Also the general "reset a managed account's password" recovery.
   */
  resetPassword(id: string, password: string): Promise<void>;
}

/** A credential handed to the notifier for delivery. Held in memory for the call
 *  only; the plaintext password is never logged and is persisted solely in OpenBao. */
export interface ProvisionedCredential {
  appId: string;
  appLabel: string;
  launchUrl: string;
  username: string;
  email: string;
  password: string;
}

/**
 * Delivery hook. The engine calls this exactly once per newly-created account.
 * The platform has no first-party SMTP sender (see the design doc), so the default
 * implementation persists the credential for an in-console reveal + audits the
 * hand-off; an SMTP-backed notifier can be dropped in without touching the engine.
 */
export interface AccountNotifier {
  notifyProvisioned(credential: ProvisionedCredential): Promise<void>;
}

/** One managed account's durable record — the source of truth for "InfraWeaver
 *  provisioned this", so manual/app-native users are never disabled. */
export interface RosterEntry {
  username: string;
  providerUserId: string;
  provisionedAt: string;
  /**
   * When the credential hand-off was recorded. Absent means it never completed —
   * the reconcile reports those as `pendingHandoff`. It is NOT what stops a re-run
   * from re-notifying: `plan.ts` only creates accounts that do not exist, so a
   * re-run never reaches the notifier at all.
   */
  notifiedAt?: string;
  /**
   * When InfraWeaver ADOPTED this account: found it live in the app under a still-
   * authorized username but missing from the roster — the residual orphan window
   * where `createUser` succeeded and `addRosterEntry` did not. Adoption re-rosters it
   * (so a revoke can disable it again), but its original password was lost with the
   * failed provision, so the credential is unknown until an admin explicitly resets
   * it. Distinct from a normal entry precisely so `pendingHandoff` never promises a
   * reveal that would 404; the reconcile reports these as `adopted` instead. The
   * account becomes an ordinary managed one once that reset sets `notifiedAt`.
   */
  adoptedAt?: string;
}

/**
 * Durable state for the engine. Injected so the reconcile is testable with an
 * in-memory fake and so a different backend (OpenBao here) is a swap, not a rewrite.
 */
export interface AppAccountStore {
  loadRoster(appId: string): Promise<RosterEntry[]>;
  addRosterEntry(appId: string, entry: RosterEntry): Promise<void>;
  markNotified(appId: string, username: string, notifiedAt: string): Promise<void>;
  removeRosterEntry(appId: string, username: string): Promise<void>;
  /** Persist a per-user credential so the console can reveal/reset it out of band. */
  writeCredential(appId: string, username: string, password: string, email: string): Promise<void>;
  deleteCredential(appId: string, username: string): Promise<void>;
}

/** The RBAC permission pair an app maps its "read" and "admin" access onto. */
export interface AppPermissionPair {
  read: Permission;
  admin: Permission;
}
