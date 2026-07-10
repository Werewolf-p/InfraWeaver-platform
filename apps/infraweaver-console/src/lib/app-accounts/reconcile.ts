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
  DesiredAppUser,
  DesiredAppUsers,
  RosterEntry,
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
  /**
   * Still-authorized accounts the roster shows as provisioned but never handed off
   * (no `notifiedAt`). This is the ONLY signal that a credential delivery failed:
   * once the account exists, {@link buildAppUserSyncPlan} never re-creates it, so
   * `provisionAccount` — and with it the notification — never runs for that user
   * again. A caller that retries the whole sync sees the next attempt succeed.
   *
   * Reported, not retried. See {@link provisionAccount} for why re-notifying is a
   * worse trade than surfacing this.
   */
  pendingHandoff: string[];
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
    // From the roster as it was BEFORE this pass: anyone provisioned earlier whose
    // hand-off never completed. Accounts created below are appended if theirs fails.
    pendingHandoff: pendingHandoffFromRoster(roster, desired.users),
  };

  for (const action of plan.create) {
    const { notified } = await provisionAccount(provider, deps, action.username, action.email, action.role);
    summary.created.push(action.username);
    if (!notified) summary.pendingHandoff.push(action.username);
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

/** App usernames compare case-insensitively, matching `plan.ts`. */
function key(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * Accounts on the roster with no `notifiedAt` that RBAC still authorizes.
 *
 * Restricted to the authorized set on purpose: a revoked account is owed no
 * hand-off, so a user who was provisioned, never notified, and later revoked drops
 * out of the report rather than nagging forever.
 *
 * A `notifiedAt` can also be missing because the notification succeeded and only
 * `markNotified` failed. That direction is the safe one to be wrong in — it asks a
 * human to confirm a delivery that already happened, rather than staying quiet
 * about one that never did.
 */
function pendingHandoffFromRoster(roster: RosterEntry[], desired: DesiredAppUser[]): string[] {
  const authorized = new Set(desired.map((user) => key(user.username)));
  return roster
    .filter((entry) => !entry.notifiedAt && authorized.has(key(entry.username)))
    .map((entry) => entry.username)
    .sort();
}

/**
 * Create one account end to end: generate a credential, create the account, record
 * it in the roster, persist the credential, set the role, and hand the credential
 * to the notifier. Resolves `{ notified }` — false when the hand-off did not land.
 *
 * Ordering is a safety property, not a style choice. The moment `createUser` returns,
 * a live account exists that only the roster makes revocable (`plan.ts` disables
 * nothing it does not manage) and only the store makes recoverable (a re-run sees the
 * username and never re-creates, so this password is generated exactly once). Both
 * durable writes therefore precede `setUserRole`, whose failure is the benign case:
 * the account is simply left at the default role, and the next sync re-roles it.
 * The plaintext password lives only in this function's scope and in the store; it is
 * never logged.
 *
 * Why a failed notification is caught rather than thrown, and never retried
 * ------------------------------------------------------------------------
 * Delivery here is PULL, not push: `notifyProvisioned` records that a credential is
 * ready, and the grantee fetches it from `GET /api/jellyfin/credential`, authorized
 * by the same SSO identity that earned the grant. So a failed notification strands
 * nobody — it loses an audit line. Letting it throw would abort the whole reconcile
 * and leave every later `plan.create` user unprovisioned behind a lost log write.
 *
 * Retrying it on a later pass, keyed on the missing `notifiedAt`, looks right and is
 * not. `ProvisionedCredential` carries the plaintext password, and by the next pass
 * this function's `password` is long gone — re-notifying means reading the plaintext
 * back out of the vault on every reconcile, to hand it to a notifier that (see
 * `notify.ts`) deliberately discards it. Today the only code that reads a plaintext
 * is the reveal route: authenticated, self-or-admin, rate-limited, and audited
 * against a named actor. A background reconcile has none of those.
 *
 * If a notifier that genuinely transmits the password ever lands (SMTP — the seam
 * exists for it), that calculus flips, and a `readCredential` on {@link AppAccountStore}
 * should land WITH it. Until then the un-notified state is reported through
 * `pendingHandoff`, and the credential stays revealable.
 */
async function provisionAccount(
  provider: AppAccountProvider,
  deps: SyncDeps,
  username: string,
  email: string,
  role: import("@/lib/app-accounts/types").AppUserRole,
): Promise<{ notified: boolean }> {
  const password = generateAppPassword();
  const account = await provider.createUser(username, password);
  const provisionedAt = new Date().toISOString();
  await deps.store.addRosterEntry(provider.appId, { username, providerUserId: account.id, provisionedAt });
  await deps.store.writeCredential(provider.appId, username, password, email);
  await provider.setUserRole(account.id, role);
  try {
    await deps.notifier.notifyProvisioned({
      appId: provider.appId,
      appLabel: provider.appLabel,
      launchUrl: provider.launchUrl,
      username,
      email,
      password,
    });
    await deps.store.markNotified(provider.appId, username, new Date().toISOString());
    return { notified: true };
  } catch (err) {
    // Not swallowed: the caller lifts this into `summary.pendingHandoff`, which the
    // access panel renders and an operator resolves with the reveal flow.
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[app-accounts] hand-off notification for '${username}' on ${provider.appId} failed; the account exists and its credential is revealable:`,
      message,
    );
    return { notified: false };
  }
}
