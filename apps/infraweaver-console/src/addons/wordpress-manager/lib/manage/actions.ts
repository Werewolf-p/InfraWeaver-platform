import "server-only";
import { z } from "zod";
import { assertValidSiteId } from "../naming";
import { siteExists, syncSiteWpUsers } from "../provision";
import { execInWpPod } from "../k8s-exec";
import { AddonHttpError, SiteNotFoundError } from "../errors";
import { requireRunningWpPod } from "./overview";
import { WP, WP_SAFE, safeWpArg } from "./wp-probe";
import { invalidateManageCache } from "./snapshot-cache";
import type { WordpressPermission } from "../wordpress-rbac";

/**
 * The allow-listed set of write actions the Manage console can perform, each
 * mapped to a concrete, shell-safe `wp-cli` command run over the secure in-pod
 * exec path. This is the ONLY place a Manage button turns into a mutation — there
 * is no free-form command channel. Every slug is validated against the strict
 * wp-cli charset before it reaches a command line, and each action declares the
 * RBAC permission the API must have already checked.
 */

const slugSchema = z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, "invalid slug");

export const manageActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("update-core") }),
  z.object({ type: z.literal("update-all") }),
  z.object({ type: z.literal("update-plugin"), slug: slugSchema }),
  z.object({ type: z.literal("update-theme"), slug: slugSchema }),
  z.object({ type: z.literal("install-plugin"), slug: slugSchema }),
  z.object({ type: z.literal("activate-plugin"), slug: slugSchema }),
  z.object({ type: z.literal("deactivate-plugin"), slug: slugSchema }),
  z.object({ type: z.literal("optimize-db") }),
  z.object({ type: z.literal("purge-transients") }),
  z.object({ type: z.literal("flush-cache") }),
  z.object({ type: z.literal("flush-rewrites") }),
  z.object({ type: z.literal("sync-users") }),
]);

export type ManageAction = z.infer<typeof manageActionSchema>;

export interface ManageActionResult {
  readonly ok: boolean;
  readonly message: string;
}

/** The RBAC permission an action requires — most are write; account sync is admin. */
export function actionPermission(action: ManageAction): WordpressPermission {
  return action.type === "sync-users" ? "wordpress:admin" : "wordpress:write";
}

/** Build the shell-safe wp-cli command for an action (null ⇒ handled specially, not via exec). */
function commandFor(action: ManageAction): string | null {
  switch (action.type) {
    case "update-core":
      return `${WP_SAFE} core update && ${WP_SAFE} core update-db`;
    case "update-all":
      return `${WP} plugin update --all && ${WP} theme update --all`;
    case "update-plugin":
      return `${WP} plugin update ${safeWpArg(action.slug)}`;
    case "update-theme":
      return `${WP} theme update ${safeWpArg(action.slug)}`;
    case "install-plugin":
      // Additive only — installs + activates from wp.org; never removes anything.
      return `${WP} plugin install ${safeWpArg(action.slug)} --activate`;
    case "activate-plugin":
      return `${WP} plugin activate ${safeWpArg(action.slug)}`;
    case "deactivate-plugin":
      return `${WP} plugin deactivate ${safeWpArg(action.slug)}`;
    case "optimize-db":
      return `${WP_SAFE} db optimize`;
    case "purge-transients":
      return `${WP_SAFE} transient delete --expired && ${WP_SAFE} transient delete --all`;
    case "flush-cache":
      return `${WP} cache flush`;
    case "flush-rewrites":
      return `${WP_SAFE} rewrite flush`;
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
  "optimize-db": "Database optimized.",
  "purge-transients": "Transients purged.",
  "flush-cache": "Object cache flushed.",
  "flush-rewrites": "Permalinks flushed.",
  "sync-users": "WordPress accounts reconciled.",
};

export async function runManageAction(site: string, action: ManageAction): Promise<ManageActionResult> {
  assertValidSiteId(site);
  if (!(await siteExists(site))) throw new SiteNotFoundError(site);

  if (action.type === "sync-users") {
    const summary = await syncSiteWpUsers(site);
    invalidateManageCache(site);
    const changed = summary.actions.filter((a) => a.action !== "unchanged").length;
    return { ok: true, message: `Accounts reconciled — ${changed} changed, ${summary.failed.length} failed.` };
  }

  const command = commandFor(action);
  if (!command) throw new AddonHttpError("Unsupported action", 400);
  const pod = await requireRunningWpPod(site);
  await execInWpPod(pod, command, { timeoutMs: 120_000 });
  // The mutation changed the site — drop its cached snapshots so the next read is fresh.
  invalidateManageCache(site);
  return { ok: true, message: SUCCESS_MESSAGE[action.type] };
}
