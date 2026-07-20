import "server-only";
import { z } from "zod";
import { assertValidSiteId } from "../naming";
import { siteExists, syncSiteWpUsers, setMaintenanceMode } from "../provision";
import { execInWpPod } from "../k8s-exec";
import { AddonHttpError, SiteNotFoundError } from "../errors";
import { requireRunningWpPod } from "./overview";
import { WP, WP_SAFE, safeWpArg, parseJsonArray, fieldStr } from "./wp-probe";
import { invalidateManageCache } from "./snapshot-cache";
import { invalidateManageReadsAfterMutation } from "./invalidate";
import { WORDPRESS_ROLES, type WordpressRoleName } from "./capabilities";
import { CONNECTOR_PLUGIN_SLUG } from "../iwsl-managed-commands";
import { sendWpPasswordResetEmail, isMailerConfigured } from "@/lib/mailer";
import type { WordpressPermission } from "../wordpress-rbac";

/**
 * The allow-listed set of write actions the Manage console can perform, each
 * mapped to a concrete, shell-safe `wp-cli` command run over the secure in-pod
 * exec path. This is the ONLY place a Manage button turns into a mutation — there
 * is no free-form command channel. Every value that reaches a command line is a
 * compile-time constant, a strict-charset-validated slug/option-key/login, a
 * numeric id, or is passed via STDIN (never argv) so secrets and free-form values
 * (passwords, option values) can hold ANY character without shell-escaping risk.
 * Each action declares the RBAC permission the API must have already checked, and
 * destructive/self-protective guardrails are enforced SERVER-SIDE here (last-admin
 * protection, connector self-protect, active-theme protection) before any command
 * runs — never relying on the UI's typed confirms alone.
 */

// ── Field schemas ────────────────────────────────────────────────────────────

const slugSchema = z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, "invalid slug");
const roleSchema = z.enum(WORDPRESS_ROLES);
const idSchema = z.coerce.number().int().positive();
const loginSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z0-9](?:[a-z0-9._-]{0,58}[a-z0-9])?$/i, "invalid login");
const emailSchema = z
  .string()
  .max(254)
  .regex(/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i, "invalid email");
const passwordSchema = z
  .string()
  .min(8)
  .max(200)
  .refine((v) => !/[\n\r]/.test(v), "password must not contain line breaks");

/**
 * The site options the Manage console may change — a strict allow-list. Anything
 * outside this set is rejected by the schema; the console never exposes a
 * free-form `wp option update`.
 */
export const WP_OPTION_ALLOWLIST = [
  "blogname",
  "blogdescription",
  "admin_email",
  "timezone_string",
  "date_format",
  "start_of_week",
] as const;

const optionKeySchema = z.enum(WP_OPTION_ALLOWLIST);
const optionValueSchema = z
  .string()
  .max(500)
  .refine((v) => !/[\n\r]/.test(v), "value must not contain line breaks");

export const manageActionSchema = z.discriminatedUnion("type", [
  // Core / plugin / theme lifecycle
  z.object({ type: z.literal("update-core") }),
  z.object({ type: z.literal("update-all") }),
  z.object({ type: z.literal("update-plugin"), slug: slugSchema }),
  z.object({ type: z.literal("update-theme"), slug: slugSchema }),
  z.object({ type: z.literal("install-plugin"), slug: slugSchema }),
  z.object({ type: z.literal("activate-plugin"), slug: slugSchema }),
  z.object({ type: z.literal("deactivate-plugin"), slug: slugSchema }),
  z.object({ type: z.literal("delete-plugin"), slug: slugSchema }),
  z.object({ type: z.literal("activate-theme"), slug: slugSchema }),
  z.object({ type: z.literal("delete-theme"), slug: slugSchema }),
  // Maintenance / DB / cache
  z.object({ type: z.literal("optimize-db") }),
  z.object({ type: z.literal("purge-transients") }),
  z.object({ type: z.literal("flush-cache") }),
  z.object({ type: z.literal("flush-rewrites") }),
  z.object({ type: z.literal("sync-users") }),
  // Users
  z.object({ type: z.literal("add-user"), login: loginSchema, email: emailSchema, role: roleSchema, password: passwordSchema.optional() }),
  z.object({ type: z.literal("update-user-email"), userId: idSchema, email: emailSchema }),
  z.object({ type: z.literal("update-user-role"), userId: idSchema, role: roleSchema }),
  z.object({ type: z.literal("set-user-password"), userId: idSchema, password: passwordSchema }),
  z.object({ type: z.literal("reset-user-password"), userId: idSchema }),
  z.object({ type: z.literal("delete-user"), userId: idSchema, reassignTo: idSchema.optional() }),
  // Settings
  z.object({ type: z.literal("update-site-option"), key: optionKeySchema, value: optionValueSchema }),
  z.object({ type: z.literal("set-maintenance-mode"), enabled: z.boolean() }),
  // Content
  z.object({ type: z.literal("trash-post"), postId: idSchema }),
  z.object({ type: z.literal("untrash-post"), postId: idSchema }),
  z.object({ type: z.literal("delete-post"), postId: idSchema }),
  z.object({
    type: z.literal("moderate-comments"),
    action: z.enum(["spam", "trash", "approve"]),
    scope: z.enum(["all", "id"]),
    commentId: idSchema.optional(),
  }),
]);

export type ManageAction = z.infer<typeof manageActionSchema>;

export interface ManageActionResult {
  readonly ok: boolean;
  readonly message: string;
}

/** Actions that mutate authentication, identity, or destroy a resource ⇒ admin. */
const ADMIN_ACTIONS: ReadonlySet<ManageAction["type"]> = new Set([
  "sync-users",
  "add-user",
  "update-user-email",
  "update-user-role",
  "set-user-password",
  "reset-user-password",
  "delete-user",
  "update-site-option",
  "delete-theme",
  "delete-plugin",
]);

/** The RBAC permission an action requires — sensitive/destructive ops need admin. */
export function actionPermission(action: ManageAction): WordpressPermission {
  return ADMIN_ACTIONS.has(action.type) ? "wordpress:admin" : "wordpress:write";
}

// ── Shell-safety helpers ─────────────────────────────────────────────────────

/** Read one line of STDIN into a shell var WITHOUT exposing it in argv or the script text. */
function readStdinInto(varName: string): string {
  return `IFS= read -r ${varName} || true`;
}

function safeLogin(login: string): string {
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,58}[a-z0-9])?$/i.test(login)) {
    throw new AddonHttpError("Invalid login", 400);
  }
  return login;
}

function safeEmail(email: string): string {
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) {
    throw new AddonHttpError("Invalid email", 400);
  }
  return email;
}

function safeRole(role: string): WordpressRoleName {
  if (!(WORDPRESS_ROLES as readonly string[]).includes(role)) {
    throw new AddonHttpError("Unknown role", 400);
  }
  return role as WordpressRoleName;
}

/** A built command plus optional STDIN (used to pass secrets/values off the command line). */
interface BuiltCommand {
  readonly command: string;
  readonly stdin?: string;
}

/** Build the moderate-comments command: a single comment by id, or the whole pending queue. */
function moderateCommentsCommand(action: Extract<ManageAction, { type: "moderate-comments" }>): string {
  const verb = action.action; // spam | trash | approve — a compile-time-safe enum value
  if (action.scope === "id") {
    if (action.commentId === undefined) throw new AddonHttpError("commentId is required when scope is 'id'", 400);
    return `${WP_SAFE} comment ${verb} ${String(action.commentId)}`;
  }
  // scope=all ⇒ act on the pending moderation queue only (held comments).
  return `for id in $(${WP_SAFE} comment list --status=hold --field=ID --format=ids); do ${WP_SAFE} comment ${verb} "$id"; done`;
}

/**
 * Build the shell-safe wp-cli command for an action (null ⇒ handled specially, not
 * via a raw exec — sync-users + set-maintenance-mode route through provision). Pure
 * and exported so the command mapping is unit-testable without a cluster.
 */
export function commandFor(action: ManageAction): BuiltCommand | null {
  switch (action.type) {
    case "update-core":
      return { command: `${WP_SAFE} core update && ${WP_SAFE} core update-db` };
    case "update-all":
      return { command: `${WP} plugin update --all && ${WP} theme update --all` };
    case "update-plugin":
      return { command: `${WP} plugin update ${safeWpArg(action.slug)}` };
    case "update-theme":
      return { command: `${WP} theme update ${safeWpArg(action.slug)}` };
    case "install-plugin":
      // Additive only — installs + activates from wp.org; never removes anything.
      return { command: `${WP} plugin install ${safeWpArg(action.slug)} --activate` };
    case "activate-plugin":
      return { command: `${WP} plugin activate ${safeWpArg(action.slug)}` };
    case "deactivate-plugin":
      return { command: `${WP} plugin deactivate ${safeWpArg(action.slug)}` };
    case "delete-plugin":
      return { command: `${WP} plugin delete ${safeWpArg(action.slug)}` };
    case "activate-theme":
      return { command: `${WP} theme activate ${safeWpArg(action.slug)}` };
    case "delete-theme":
      return { command: `${WP} theme delete ${safeWpArg(action.slug)}` };
    case "optimize-db":
      return { command: `${WP_SAFE} db optimize` };
    case "purge-transients":
      return { command: `${WP_SAFE} transient delete --expired && ${WP_SAFE} transient delete --all` };
    case "flush-cache":
      return { command: `${WP} cache flush` };
    case "flush-rewrites":
      return { command: `${WP_SAFE} rewrite flush` };
    // Users — logins/emails are charset-validated; passwords ride STDIN (never argv).
    case "add-user": {
      const login = safeLogin(action.login);
      const email = safeEmail(action.email);
      const role = safeRole(action.role);
      if (action.password !== undefined) {
        return {
          command: `${readStdinInto("WP_PASS")}; ${WP_SAFE} user create ${login} ${email} --role=${role} --user_pass="$WP_PASS" --porcelain`,
          stdin: action.password,
        };
      }
      // No password supplied ⇒ generate a strong one in-pod (members sign in via SSO).
      return {
        command: `${WP_SAFE} user create ${login} ${email} --role=${role} --user_pass="$(head -c 32 /dev/urandom | base64)" --porcelain`,
      };
    }
    case "update-user-email":
      return { command: `${WP_SAFE} user update ${String(action.userId)} --user_email=${safeEmail(action.email)} --skip-email` };
    case "update-user-role":
      return { command: `${WP_SAFE} user update ${String(action.userId)} --role=${safeRole(action.role)} --skip-email` };
    case "set-user-password":
      return {
        command: `${readStdinInto("WP_PASS")}; ${WP_SAFE} user update ${String(action.userId)} --user_pass="$WP_PASS" --skip-email`,
        stdin: action.password,
      };
    case "reset-user-password":
      // Generates a fresh password and emails the user a reset notification (WP core parity).
      return { command: `${WP_SAFE} user reset-password ${String(action.userId)}` };
    case "delete-user": {
      const reassign = action.reassignTo !== undefined ? ` --reassign=${String(action.reassignTo)}` : "";
      return { command: `${WP_SAFE} user delete ${String(action.userId)}${reassign} --yes` };
    }
    // Settings — value rides STDIN so any character is safe; admin_email is shape-checked.
    case "update-site-option": {
      if (action.key === "admin_email") safeEmail(action.value);
      return {
        command: `${readStdinInto("WP_VAL")}; ${WP_SAFE} option update ${safeWpArg(action.key)} "$WP_VAL"`,
        stdin: action.value,
      };
    }
    case "set-maintenance-mode":
      return null; // routed through provision.setMaintenanceMode
    // Content
    case "trash-post":
      return { command: `${WP_SAFE} post delete ${String(action.postId)}` };
    case "untrash-post":
      // wp-cli has no untrash verb — restore the post to draft so an editor can republish.
      return { command: `${WP_SAFE} post update ${String(action.postId)} --post_status=draft` };
    case "delete-post":
      return { command: `${WP_SAFE} post delete ${String(action.postId)} --force` };
    case "moderate-comments":
      return { command: moderateCommentsCommand(action) };
    case "sync-users":
      return null; // routed through the existing secure account-sync path
  }
}

const SUCCESS_MESSAGE: Record<ManageAction["type"], string> = {
  "update-core": "WordPress core updated.",
  "update-all": "All plugins and themes updated.",
  "update-plugin": "Plugin updated.",
  "update-theme": "Theme updated.",
  "install-plugin": "Plugin installed and activated.",
  "activate-plugin": "Plugin activated.",
  "deactivate-plugin": "Plugin deactivated.",
  "delete-plugin": "Plugin deleted.",
  "activate-theme": "Theme activated.",
  "delete-theme": "Theme deleted.",
  "optimize-db": "Database optimized.",
  "purge-transients": "Transients purged.",
  "flush-cache": "Object cache flushed.",
  "flush-rewrites": "Permalinks flushed.",
  "sync-users": "WordPress accounts reconciled.",
  "add-user": "User created.",
  "update-user-email": "User email updated.",
  "update-user-role": "User role updated.",
  "set-user-password": "User password set.",
  "reset-user-password": "Password reset link sent.",
  "delete-user": "User deleted.",
  "update-site-option": "Setting saved.",
  "set-maintenance-mode": "Maintenance mode updated.",
  "trash-post": "Post moved to trash.",
  "untrash-post": "Post restored to draft.",
  "delete-post": "Post permanently deleted.",
  "moderate-comments": "Comments moderated.",
};

// ── Server-side guardrails ───────────────────────────────────────────────────

type ExecFn = (
  script: string,
  opts?: { stdin?: string; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

/** The connector's optional dedicated WP service login, when an operator has configured one. */
const CONNECTOR_SERVICE_LOGIN = process.env.WP_CONNECTOR_SERVICE_LOGIN?.trim() || null;

/**
 * Parse `wp user list --role=administrator --fields=ID --format=json` (object rows
 * `[{"ID":1}]`) into admin ids. Tolerates a scalar array + string ids too, so the
 * guardrail can never be silently blanked by a wp-cli output-shape change. Pure.
 */
export function parseAdministratorIds(stdout: string): number[] {
  return parseJsonArray<unknown>(stdout)
    .map((v) => {
      if (typeof v === "number") return v;
      if (typeof v === "string") return Number(v);
      if (v && typeof v === "object" && "ID" in v) return Number((v as { ID: unknown }).ID);
      return NaN;
    })
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** True when `userId` is the site's only remaining administrator. Pure. */
export function isLastAdmin(adminIds: readonly number[], userId: number): boolean {
  return adminIds.length <= 1 && adminIds.includes(userId);
}

/** Read the site's current administrator ids (fails CLOSED — a read error refuses the op). */
async function readAdministratorIds(exec: ExecFn): Promise<number[]> {
  // Plural `--fields=ID` prints object rows (`[{"ID":1}]`) — the object-shaped read,
  // never the scalar-array footgun the singular `--field=` form produces.
  const { stdout } = await exec(`${WP_SAFE} user list --role=administrator --fields=ID --format=json`);
  return parseAdministratorIds(stdout);
}

/** The active theme's slug (lowercased), or null when unreadable. */
async function activeThemeSlug(exec: ExecFn): Promise<string | null> {
  const { stdout } = await exec(`${WP} theme list --status=active --fields=name --format=json`).catch(() => ({ stdout: "[]", stderr: "" }));
  const first = parseJsonArray<Record<string, unknown>>(stdout)[0];
  const name = first ? fieldStr(first, "name") : null;
  return name ? name.toLowerCase() : null;
}

/** The WP user id for a login, or null when the account does not exist. */
async function userIdForLogin(exec: ExecFn, login: string): Promise<number | null> {
  const { stdout } = await exec(`${WP_SAFE} user get ${safeWpArg(login)} --field=ID`).catch(() => ({ stdout: "", stderr: "" }));
  const n = Number(stdout.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Enforce the destructive/self-protective guardrails that need to READ live state
 * (admin count, active theme, connector service account) before a mutation runs.
 * Throws AddonHttpError(409) on a violation. Pure connector-slug checks live here
 * too so both plugin-removal paths are covered.
 */
async function enforceGuardrails(action: ManageAction, exec: ExecFn): Promise<void> {
  switch (action.type) {
    case "deactivate-plugin":
    case "delete-plugin":
      if (action.slug.toLowerCase() === CONNECTOR_PLUGIN_SLUG) {
        throw new AddonHttpError(
          "Refusing to deactivate or remove the InfraWeaver Connector — it manages this site's secure link.",
          409,
        );
      }
      return;
    case "delete-theme": {
      const active = await activeThemeSlug(exec);
      if (active && active === action.slug.toLowerCase()) {
        throw new AddonHttpError("Refusing to delete the active theme — activate another theme first.", 409);
      }
      return;
    }
    case "delete-user": {
      // Connector self-protect — refuse deleting a configured connector service account.
      if (CONNECTOR_SERVICE_LOGIN) {
        const svcId = await userIdForLogin(exec, CONNECTOR_SERVICE_LOGIN);
        if (svcId !== null && svcId === action.userId) {
          throw new AddonHttpError("Refusing to delete the InfraWeaver Connector service account.", 409);
        }
      }
      const admins = await readAdministratorIds(exec);
      if (isLastAdmin(admins, action.userId)) {
        throw new AddonHttpError("Refusing to delete the last administrator — create another administrator first.", 409);
      }
      return;
    }
    case "update-user-role": {
      // Only a DEMOTION away from administrator can strip the last admin.
      if (action.role !== "administrator") {
        const admins = await readAdministratorIds(exec);
        if (isLastAdmin(admins, action.userId)) {
          throw new AddonHttpError("Refusing to demote the last administrator — assign another administrator first.", 409);
        }
      }
      return;
    }
    default:
      return;
  }
}

export async function runManageAction(site: string, action: ManageAction): Promise<ManageActionResult> {
  assertValidSiteId(site);
  if (!(await siteExists(site))) throw new SiteNotFoundError(site);

  // Actions routed through vetted provisioning capabilities rather than a raw exec.
  if (action.type === "sync-users") {
    const summary = await syncSiteWpUsers(site);
    await invalidateManageReadsAfterMutation(site);
    const changed = summary.actions.filter((a) => a.action !== "unchanged").length;
    return { ok: true, message: `Accounts reconciled — ${changed} changed, ${summary.failed.length} failed.` };
  }
  if (action.type === "set-maintenance-mode") {
    await setMaintenanceMode(site, action.enabled);
    await invalidateManageReadsAfterMutation(site);
    return { ok: true, message: action.enabled ? "Maintenance mode enabled." : "Maintenance mode disabled." };
  }

  const pod = await requireRunningWpPod(site);
  const exec: ExecFn = (script, opts) => execInWpPod(pod, script, opts);

  // Destructive/self-protective guardrails run BEFORE the mutation command.
  await enforceGuardrails(action, exec);

  // Reset link is delivered through the CONSOLE's InfraWeaver SMTP, not the site's
  // own mailer (which many managed sites can't send) — so it short-circuits the
  // generic exec path.
  if (action.type === "reset-user-password") {
    return emailWpPasswordResetLink(site, action.userId, exec);
  }

  const built = commandFor(action);
  if (!built) throw new AddonHttpError("Unsupported action", 400);
  await exec(built.command, { timeoutMs: 120_000, stdin: built.stdin });
  // The mutation changed the site — drop its cached reads (in-memory AND the durable
  // cross-replica snapshots) so the next read reflects the change instead of the
  // pre-mutation snapshot the console would otherwise serve durable-first.
  await invalidateManageReadsAfterMutation(site);
  return { ok: true, message: SUCCESS_MESSAGE[action.type] };
}

/** The fields the reset-link eval returns from the site (all optional/untrusted). */
interface WpResetTargetRow {
  email?: unknown;
  name?: unknown;
  reset_url?: unknown;
  site_name?: unknown;
  site_url?: unknown;
}

/** Normalized reset target — the shape the branded email needs. */
export interface WpResetTarget {
  email: string;
  name: string;
  resetUrl: string;
  siteName: string;
  siteUrl: string;
}

/**
 * Parse the JSON blob the in-pod `wp eval` prints for a reset request. Returns null
 * when the output is empty/malformed or carries no reset URL. Pure + exported so the
 * parsing is unit-tested without a live pod.
 */
export function parseResetTarget(stdout: string): WpResetTarget | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  let obj: WpResetTargetRow;
  try {
    obj = JSON.parse(trimmed) as WpResetTargetRow;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const resetUrl = typeof obj.reset_url === "string" ? obj.reset_url.trim() : "";
  if (!resetUrl) return null;
  return {
    email: typeof obj.email === "string" ? obj.email.trim() : "",
    name: typeof obj.name === "string" ? obj.name : "",
    resetUrl,
    siteName: typeof obj.site_name === "string" ? obj.site_name : "",
    siteUrl: typeof obj.site_url === "string" ? obj.site_url : "",
  };
}

/** The PHP the site evals to MINT a reset key + assemble the reset URL without
 * sending WordPress's own email. `userId` is a validated integer — the only value
 * interpolated — so nothing free-form reaches the eval. */
function resetLinkEvalPhp(userId: number): string {
  return [
    `$u=get_user_by("id", ${userId});`,
    `if(!$u){exit(3);}`,
    `echo json_encode(array(`,
    `"email"=>$u->user_email,`,
    `"name"=>$u->display_name,`,
    `"reset_url"=>network_site_url("wp-login.php?action=rp&key=".get_password_reset_key($u)."&login=".rawurlencode($u->user_login),"login"),`,
    `"site_name"=>get_option("blogname"),`,
    `"site_url"=>home_url("/")`,
    `));`,
  ].join("");
}

/**
 * Mint a single-use password-reset link ON THE SITE (no WP-side email) and deliver
 * it through the console's InfraWeaver SMTP with the branded template. Refuses up
 * front if the console mailer is not configured, so the operator gets a clear
 * message instead of a silent no-op — the exact failure mode of the old
 * `wp user reset-password` path on sites without SMTP.
 */
async function emailWpPasswordResetLink(site: string, userId: number, exec: ExecFn): Promise<ManageActionResult> {
  if (!isMailerConfigured()) {
    throw new AddonHttpError(
      "InfraWeaver SMTP is not configured on the console — set it up in Settings before emailing password reset links.",
      409,
    );
  }
  const { stdout } = await exec(`${WP_SAFE} eval '${resetLinkEvalPhp(userId)}'`);
  const target = parseResetTarget(stdout);
  if (!target) {
    throw new AddonHttpError("Could not read that user or mint a reset link on the site.", 502);
  }
  if (!target.email) {
    throw new AddonHttpError("That user has no email address on file — add one before sending a reset link.", 409);
  }
  await sendWpPasswordResetEmail({
    to: target.email,
    displayName: target.name,
    siteName: target.siteName || site,
    siteUrl: target.siteUrl || `https://${site}`,
    resetUrl: target.resetUrl,
  });
  invalidateManageCache(site);
  return { ok: true, message: `Password reset link emailed to ${target.email} via InfraWeaver.` };
}
