/**
 * The generic app-account reconcile engine.
 *
 * Given a {@link AppAccountProvider} (the app), the RBAC-derived desired accounts,
 * and the durable store + notifier, converge the app's local accounts onto RBAC:
 * create the newly-authorized (with a random password, stored + delivered once),
 * re-role/re-enable the still-authorized, and disable the revoked.
 *
 * Everything app-specific is behind the injected interfaces, so this file is the
 * SAME for every app — a second app is a new provider, not a fork of this engine —
 * and the whole thing is unit-testable with in-memory fakes (no OpenBao, no HTTP).
 */
import "server-only";
import { buildAppUserSyncPlan } from "@/lib/app-accounts/plan";
import { generateAppPassword } from "@/lib/app-accounts/password";
import type {
  AccountNotifier,
  AppAccountProvider,
  AppAccountStore,
  DesiredAppUsers,
} from "@/lib/app-accounts/types";

export interface SyncDeps {
  store: AppAccountStore;
  notifier: AccountNotifier;
  /** Usernames never provisioned or disabled beyond the provider's own service
   *  account (e.g. the operator's personal admin). Optional. */
  protectedUsernames?: string[];
}

export interface AppUserSyncSummary {
  created: string[];
  roleChanged: string[];
  enabled: string[];
  disabled: string[];
  /** Authorized users skipped for lack of an email to deliver the credential to. */
  skippedNoEmail: string[];
}

/**
 * Reconcile one app's local accounts to `desired`. Idempotent: only accounts
 * absent from the app are created (and therefore only they are emailed), so a
 * re-run with unchanged grants makes no changes and sends no notification.
 *
 * Ordering is deliberate — creations/enables/role-changes first, disables last —
 * so a transient failure mid-run never leaves a still-authorized user locked out
 * while a soon-to-be-revoked one lingers; the revoke simply retries next pass.
 */
export async function syncAppUsers(
  provider: AppAccountProvider,
  desired: DesiredAppUsers,
  deps: SyncDeps,
): Promise<AppUserSyncSummary> {
  await provider.ensureServiceAccount();

  const [existing, roster] = await Promise.all([provider.listUsers(), deps.store.loadRoster(provider.appId)]);
  const plan = buildAppUserSyncPlan({
    desired: desired.users,
    existing,
    managed: roster.map((entry) => entry.username),
    protectedUsernames: [provider.serviceAccountUsername, ...(deps.protectedUsernames ?? [])],
  });

  const summary: AppUserSyncSummary = {
    created: [],
    roleChanged: [],
    enabled: [],
    disabled: [],
    skippedNoEmail: desired.skippedNoEmail,
  };

  for (const action of plan.create) {
    await provisionAccount(provider, deps, action.username, action.email, action.role);
    summary.created.push(action.username);
  }
  for (const action of plan.setRole) {
    await provider.setUserRole(action.id, action.role);
    summary.roleChanged.push(action.username);
  }
  for (const action of plan.enable) {
    await provider.enableUser(action.id);
    summary.enabled.push(action.username);
  }
  for (const action of plan.disable) {
    await provider.disableUser(action.id);
    summary.disabled.push(action.username);
  }

  return summary;
}

/**
 * Create one account end to end: generate a credential, create + role the account,
 * record it in the roster, persist the credential to the store, and deliver it once.
 * The roster entry is written right after the account exists so a crash before
 * `notifyProvisioned` can never re-create (the username now exists) — at-least-once
 * delivery, never a duplicate account. The plaintext password lives only in this
 * function's scope and in the store; it is never logged.
 */
async function provisionAccount(
  provider: AppAccountProvider,
  deps: SyncDeps,
  username: string,
  email: string,
  role: import("@/lib/app-accounts/types").AppUserRole,
): Promise<void> {
  const password = generateAppPassword();
  const account = await provider.createUser(username, password);
  await provider.setUserRole(account.id, role);
  const provisionedAt = new Date().toISOString();
  await deps.store.addRosterEntry(provider.appId, { username, providerUserId: account.id, provisionedAt });
  await deps.store.writeCredential(provider.appId, username, password, email);
  await deps.notifier.notifyProvisioned({
    appId: provider.appId,
    appLabel: provider.appLabel,
    launchUrl: provider.launchUrl,
    username,
    email,
    password,
  });
  await deps.store.markNotified(provider.appId, username, new Date().toISOString());
}
