import "server-only";
import {
  grantRoleAssignment,
  type AssignmentActionContext,
} from "@/lib/rbac-assignments";
import {
  loadUsersConfig,
  saveUsersConfig,
  findUserByIdentity,
  type UsersConfigUser,
} from "@/lib/users-config";
import { wordpressScope } from "./wordpress-rbac";
import { runManageAction } from "./manage/actions";
import { AddonHttpError } from "./errors";
import { wpRoleToRbacRoleId, isAdminTierWpRole, type WordpressRbacRoleId } from "./manage/wp-role-mapping";
import type { WordpressRoleName } from "./manage/capabilities";

/**
 * Grant an EXISTING Authentik user access to one WordPress site with a chosen
 * WordPress role, pre-creating their WordPress account before their first SSO login.
 *
 * Two coordinated writes, in dependency order:
 *   1. RBAC — a per-site `wordpress:*` role assignment scoped to `/wordpress/sites/<site>`.
 *      This is the SECURITY CONTROL: the site's Authentik gate authorizes exactly the
 *      users RBAC grants (see access-policy.ts). Delegated to the shared
 *      `grantRoleAssignment`, so the privilege ceiling, audit log, git commit, and the
 *      downstream Authentik-group + WordPress-account reconcile are all reused, not
 *      re-implemented.
 *   2. WordPress — an idempotent, signed `ensure-user` manage action that creates the
 *      account with the EXACT chosen role and the Authentik user's EMAIL. Because the
 *      site's OIDC plugin is configured `identity_key:"email"` + `link_existing_users`,
 *      first SSO login links to this account by email (no duplicate); the username need
 *      not match the email. If an account with that email already exists the action is a
 *      no-op ("already has access").
 *
 * Step 2 is NON-FATAL: the RBAC grant already authorizes the user, and the async
 * `syncSiteWpUsers` reconcile (fired by the grant) materializes the account if the
 * site's pod is momentarily unavailable.
 */

/** A WordPress login must match the connector's allow-listed charset (mirrors loginSchema). */
const WP_LOGIN_RE = /^[a-z0-9](?:[a-z0-9._-]{0,58}[a-z0-9])?$/i;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

export interface GrantWpAccessInput {
  readonly site: string;
  /** The Authentik username (also the WordPress login for the pre-created account). */
  readonly username: string;
  /** The Authentik user's canonical email — authoritative, resolved server-side. */
  readonly email: string;
  /** Display name, used only when a users.yaml record must be created. */
  readonly name: string;
  /** The full-set WordPress role the operator chose. */
  readonly wpRole: WordpressRoleName;
}

export interface GrantWpAccessSuccess {
  readonly ok: true;
  /** Whether the RBAC assignment was newly created or already present (idempotent). */
  readonly rbac: "granted" | "already-granted";
  /** Whether the WordPress account was ensured now, or deferred to the async reconcile. */
  readonly wpAccount: "ensured" | "deferred";
  readonly roleId: WordpressRbacRoleId;
  readonly wpRole: WordpressRoleName;
  /** Present only when the pre-create was deferred — a human-readable reason. */
  readonly wpAccountNote?: string;
}

export interface GrantWpAccessFailure {
  readonly ok: false;
  readonly status: number;
  readonly error: string;
}

export type GrantWpAccessResult = GrantWpAccessSuccess | GrantWpAccessFailure;

/** Caller-context privilege facts the grant enforces on top of the RBAC ceiling. */
export interface GrantWpAccessOptions {
  /** Whether the caller holds rbac:admin — required to grant administrator-tier access. */
  readonly callerHasRbacAdmin: boolean;
}

/**
 * Ensure a users.yaml record exists for the grantee so a user-principal role
 * assignment can be stored on it (a grant to an absent user 404s). Resolves an
 * existing record by username OR email (tolerating a drifted key), creating a
 * minimal `{ name, email }` record only when none is found. Returns the users.yaml
 * key to grant under.
 */
async function ensureUserRecord(username: string, email: string, name: string): Promise<string> {
  const cfg = await loadUsersConfig();
  const match = findUserByIdentity(cfg.users, { username, email });
  if (match) return match.username;

  const record: UsersConfigUser = { name: name || username, email };
  const users = { ...cfg.users, [username]: record };
  await saveUsersConfig(users, cfg.sha, `wordpress: provision user ${username} for site access grant`, cfg.groups);
  return username;
}

export async function grantWordpressSiteAccess(
  input: GrantWpAccessInput,
  ctx: AssignmentActionContext,
  opts: GrantWpAccessOptions,
): Promise<GrantWpAccessResult> {
  // Privilege ceiling: administrator-tier WordPress access requires rbac:admin
  // (mirrors the invite route's privilegedPresets gate). Checked before any write.
  if (isAdminTierWpRole(input.wpRole) && !opts.callerHasRbacAdmin) {
    return { ok: false, status: 403, error: "Granting administrator access requires rbac:admin" };
  }

  // Validate shapes up front so nothing is written when the login/email can't be
  // used — the RBAC grant must never land while the pre-create is doomed to 400.
  if (!WP_LOGIN_RE.test(input.username)) {
    return { ok: false, status: 400, error: "Authentik username is not a valid WordPress login" };
  }
  if (!EMAIL_RE.test(input.email)) {
    return { ok: false, status: 409, error: "That Authentik user has no usable email address" };
  }

  const roleId = wpRoleToRbacRoleId(input.wpRole);
  const scope = wordpressScope(input.site);

  const principal = await ensureUserRecord(input.username, input.email, input.name);

  // 1. RBAC grant — ceiling, audit, commit and downstream reconcile live in the shared helper.
  const grant = await grantRoleAssignment(
    { roleId, scope, principalType: "user", principal, effect: "Allow" },
    ctx,
  );
  let rbac: "granted" | "already-granted";
  if (grant.ok) {
    rbac = "granted";
  } else if (grant.status === 409) {
    rbac = "already-granted"; // an identical assignment already exists — idempotent
  } else {
    return { ok: false, status: grant.status, error: grant.error };
  }

  // 2. Signed, idempotent pre-create with the EXACT chosen role. Non-fatal.
  let wpAccount: "ensured" | "deferred" = "ensured";
  let wpAccountNote: string | undefined;
  try {
    await runManageAction(input.site, {
      type: "ensure-user",
      login: input.username,
      email: input.email,
      role: input.wpRole,
    });
  } catch (err) {
    wpAccount = "deferred";
    wpAccountNote =
      err instanceof AddonHttpError
        ? err.message
        : "WordPress account will be created on the next reconcile.";
    console.warn(
      `[wordpress:grant] pre-create for '${input.username}' on '${input.site}' deferred:`,
      err instanceof Error ? err.message : err,
    );
  }

  return { ok: true, rbac, wpAccount, roleId, wpRole: input.wpRole, ...(wpAccountNote ? { wpAccountNote } : {}) };
}
