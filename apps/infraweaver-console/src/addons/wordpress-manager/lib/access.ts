/**
 * Server-side orchestration of a WordPress site's Authentik access group. Ties the
 * reusable `@/lib/sso/access` capability to the addon's identity model (users.yaml)
 * so a grant/revoke in InfraWeaver automatically provisions/deprovisions the user's
 * ability to sign into the site.
 */
import "server-only";
import { loadUsersConfig } from "@/lib/users-config";
import {
  ensureAppAccessGroup,
  syncAppAccessMembers,
  removeAppAccessGroup,
  type AccessSyncResult,
} from "@/lib/sso/access";
import { computeSiteAccessUsers } from "./access-policy";

/** Stable Authentik group name that gates a site (unique per site). */
export function siteAccessGroupName(site: string): string {
  return `wordpress-${site}-access`;
}

/**
 * The Authentik application slug base and its forward-auth gate variant for a site.
 * Must match the `appSlug` used in `enableSso`/`removeSsoGate` (`wordpress-<site>`)
 * and the gate app `ensureSsoGate` derives (`<appSlug>-gate`).
 */
export function siteAppSlugs(site: string): string[] {
  return [`wordpress-${site}`, `wordpress-${site}-gate`];
}

/** The usernames InfraWeaver currently authorizes for `site`, read from users.yaml. */
export async function listSiteAccessUsers(site: string): Promise<string[]> {
  const cfg = await loadUsersConfig();
  return computeSiteAccessUsers(site, cfg.users, cfg.groups);
}

/**
 * Ensure the site's access group exists, is bound to its Authentik application(s),
 * and contains exactly the currently-authorized users. Call once SSO is enabled and
 * again whenever placement changes; idempotent.
 */
export async function ensureSiteAccess(site: string): Promise<AccessSyncResult> {
  await ensureAppAccessGroup({ groupName: siteAccessGroupName(site), appSlugs: siteAppSlugs(site) });
  return syncAppAccessMembers(siteAccessGroupName(site), await listSiteAccessUsers(site));
}

/** Reconcile only the group's membership to the current RBAC-derived set. */
export async function syncSiteAccess(site: string): Promise<AccessSyncResult> {
  return syncAppAccessMembers(siteAccessGroupName(site), await listSiteAccessUsers(site));
}

/** Tear down the site's access group (bindings die with it). Idempotent. */
export async function removeSiteAccess(site: string): Promise<void> {
  await removeAppAccessGroup(siteAccessGroupName(site));
}
