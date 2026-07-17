/**
 * wp-cli command builders + output parsing for reconciling a site's WordPress
 * accounts onto the RBAC-derived desired set (see access-policy
 * `computeSiteWordpressUsers`). Pure and shell-safety-focused: every value that
 * reaches a command line is validated against a strict character set first, so
 * a hostile users.yaml entry can never break out of the script.
 *
 * The exec layer runs these through `sh -c` inside the WordPress container.
 */
import type { DesiredWordpressUser, WordpressRole } from "./access-policy";

// WordPress accepts a wider login charset, but InfraWeaver usernames are slugs;
// anything outside this alphabet is refused rather than quoted.
const WP_LOGIN_RE = /^[a-z0-9](?:[a-z0-9._-]{0,58}[a-z0-9])?$/i;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const WP_ROLES: readonly WordpressRole[] = ["administrator", "editor", "subscriber"];

function safeLogin(login: string): string {
  if (!WP_LOGIN_RE.test(login)) throw new Error(`refusing unsafe WordPress login: ${JSON.stringify(login)}`);
  return login;
}

function safeEmail(email: string): string {
  if (!EMAIL_RE.test(email)) throw new Error(`refusing unsafe WordPress email: ${JSON.stringify(email)}`);
  return email;
}

function safeRole(role: WordpressRole): WordpressRole {
  if (!WP_ROLES.includes(role)) throw new Error(`refusing unknown WordPress role: ${JSON.stringify(role)}`);
  return role;
}

/** Current accounts with their roles, machine-readable. */
export function listWpUsersCommand(): string {
  return "wp --allow-root user list --fields=user_login,roles --format=json";
}

export interface ExistingWpUser {
  login: string;
  /** wp-cli reports roles as a comma-separated string (usually a single role). */
  roles: string;
}

/** Parse `wp user list --format=json`; unparseable output maps to an empty list. */
export function parseWpUserList(stdout: string): ExistingWpUser[] {
  const start = stdout.indexOf("[");
  if (start === -1) return [];
  try {
    const raw = JSON.parse(stdout.slice(start)) as Array<{ user_login?: string; roles?: string }>;
    return raw
      .map((entry) => ({ login: entry.user_login ?? "", roles: entry.roles ?? "" }))
      .filter((entry) => entry.login !== "");
  } catch {
    return [];
  }
}

/**
 * Create one account with the mapped role. The password is generated inside the
 * pod (never leaves it, never appears in the exec audit log) and is irrelevant
 * in practice: members sign in through Authentik, which links to this account
 * by email.
 */
export function createWpUserCommand(user: DesiredWordpressUser): string {
  const login = safeLogin(user.username);
  return (
    `wp --allow-root user create ${login} ${safeEmail(user.email)} ` +
    `--role=${safeRole(user.role)} --user_pass="$(head -c 32 /dev/urandom | base64)" --porcelain`
  );
}

/** Converge an existing account's role (and email) onto the desired state. */
export function updateWpUserCommand(user: DesiredWordpressUser): string {
  const login = safeLogin(user.username);
  return (
    `wp --allow-root user update ${login} ` +
    `--role=${safeRole(user.role)} --user_email=${safeEmail(user.email)} --skip-email`
  );
}

export interface WpUserSyncAction {
  username: string;
  role: WordpressRole;
  /** `failed` is set at apply time when the account's command threw. */
  action: "created" | "updated" | "unchanged" | "failed";
}

export interface WpUserSyncPlan {
  /** Ordered commands to run; parallel to `actions` entries that need work. */
  commands: string[];
  actions: WpUserSyncAction[];
}

export interface WpUserSyncFailure {
  username: string;
  /** Bounded, human-readable reason (the exec error), safe to show an operator. */
  reason: string;
}

export interface WpUserSyncResult {
  actions: WpUserSyncAction[];
  failed: WpUserSyncFailure[];
}

/** Compress an exec error into a short, single-line reason for the summary. */
function userSyncFailureReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/\s+/g, " ").trim().slice(0, 200) || "unknown error";
}

/**
 * Run a plan's create/update commands, tolerating a per-account failure.
 * `commands[i]` converges the i-th *actionable* account (the non-`unchanged`
 * actions, in the order buildWpUserSyncPlan emitted them). A command that throws
 * — a transient wp-cli/DB race, or a duplicate from a concurrent reconcile — is
 * recorded against its user and the remaining accounts still reconcile, so one
 * bad account never sinks the whole sync (and never surfaces as a bare 500).
 */
export async function applyWpUserSyncPlan(
  plan: WpUserSyncPlan,
  run: (command: string) => Promise<void>,
): Promise<WpUserSyncResult> {
  const actionable = plan.actions.filter((entry) => entry.action !== "unchanged");
  const failed: WpUserSyncFailure[] = [];
  for (let i = 0; i < plan.commands.length; i += 1) {
    try {
      await run(plan.commands[i]);
    } catch (err) {
      const target = actionable[i];
      if (target) {
        target.action = "failed";
        failed.push({ username: target.username, reason: userSyncFailureReason(err) });
      }
    }
  }
  return { actions: plan.actions, failed };
}

/**
 * The commands that converge existing accounts onto the desired set. Accounts
 * not in the desired set are left alone — the Authentik gate is the enforcement
 * point for revocation, and deleting WordPress users would orphan their content.
 * The protected install account (`adminLogin`) is never touched.
 */
export function buildWpUserSyncPlan(
  desired: readonly DesiredWordpressUser[],
  existing: readonly ExistingWpUser[],
  adminLogin: string,
): WpUserSyncPlan {
  const existingByLogin = new Map(existing.map((user) => [user.login.toLowerCase(), user]));
  const commands: string[] = [];
  const actions: WpUserSyncAction[] = [];

  for (const user of desired) {
    if (user.username.toLowerCase() === adminLogin.toLowerCase()) continue;
    const current = existingByLogin.get(user.username.toLowerCase());
    if (!current) {
      commands.push(createWpUserCommand(user));
      actions.push({ username: user.username, role: user.role, action: "created" });
    } else if (!current.roles.split(",").map((role) => role.trim()).includes(user.role)) {
      commands.push(updateWpUserCommand(user));
      actions.push({ username: user.username, role: user.role, action: "updated" });
    } else {
      actions.push({ username: user.username, role: user.role, action: "unchanged" });
    }
  }

  return { commands, actions };
}
