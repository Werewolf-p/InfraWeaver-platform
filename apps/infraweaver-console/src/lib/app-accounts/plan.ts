/**
 * Pure reconcile plan: given the desired accounts (from RBAC), what already exists
 * in the app, and which usernames InfraWeaver manages, decide the minimal set of
 * provider actions. No I/O — this is the unit-tested heart of the engine, mirroring
 * the WordPress addon's `buildWpUserSyncPlan`.
 *
 * The invariants it encodes:
 *   - CREATE only accounts that do not already exist. Re-running never re-creates,
 *     which is what stops a re-run from resetting a password or re-emailing.
 *   - Only ever DISABLE an account InfraWeaver itself provisioned (in the roster).
 *     Manual/app-native accounts and the service account are never touched.
 *   - Revocation DISABLES (retains the account + its stored credential) rather than
 *     deletes, so a re-grant re-enables the same account with no password churn.
 */
import type { AppUserAccount, AppUserRole, DesiredAppUser } from "@/lib/app-accounts/types";

export interface CreateAction {
  username: string;
  email: string;
  role: AppUserRole;
}

export interface AppUserSyncPlan {
  /** Accounts to create (then set role, store credential, notify). */
  create: CreateAction[];
  /** Existing accounts whose role must change: (id, desired role). */
  setRole: { id: string; username: string; role: AppUserRole }[];
  /** Previously-disabled managed accounts a fresh grant re-enables. */
  enable: { id: string; username: string }[];
  /** Managed accounts no longer authorized — disable (the revoke action). */
  disable: { id: string; username: string }[];
}

export interface PlanInput {
  desired: DesiredAppUser[];
  existing: AppUserAccount[];
  /** Usernames InfraWeaver provisioned (the roster) — the only ones it may disable. */
  managed: string[];
  /** Usernames never to create/disable/mutate (the service account, plus any the
   *  operator wants held out). Matched case-insensitively like `existing`. */
  protectedUsernames: string[];
}

/** App usernames compare case-insensitively (Jellyfin folds case), so key on lower. */
function key(username: string): string {
  return username.trim().toLowerCase();
}

export function buildAppUserSyncPlan(input: PlanInput): AppUserSyncPlan {
  const existingByName = new Map(input.existing.map((account) => [key(account.username), account]));
  const desiredByName = new Map(input.desired.map((user) => [key(user.username), user]));
  const managed = new Set(input.managed.map(key));
  const isProtected = new Set(input.protectedUsernames.map(key));

  const plan: AppUserSyncPlan = { create: [], setRole: [], enable: [], disable: [] };

  for (const user of input.desired) {
    const k = key(user.username);
    if (isProtected.has(k)) continue; // never provision over a held-out/service name
    const account = existingByName.get(k);
    if (!account) {
      plan.create.push({ username: user.username, email: user.email, role: user.role });
      continue;
    }
    // Exists already: converge role and re-enable if a prior revoke disabled it.
    // Never resets the password — that is an explicit admin action, not a sync.
    if (account.role !== user.role) plan.setRole.push({ id: account.id, username: account.username, role: user.role });
    if (account.disabled) plan.enable.push({ id: account.id, username: account.username });
  }

  for (const account of input.existing) {
    const k = key(account.username);
    if (isProtected.has(k) || !managed.has(k)) continue; // only disable what we manage
    if (desiredByName.has(k)) continue; // still authorized
    if (account.disabled) continue; // already revoked
    plan.disable.push({ id: account.id, username: account.username });
  }

  return plan;
}
