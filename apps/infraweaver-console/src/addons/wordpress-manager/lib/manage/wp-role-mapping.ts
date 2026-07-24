/**
 * Pure mapping between the full WordPress role set an operator can pick in the
 * "grant existing user" picker and the three-tier InfraWeaver RBAC WordPress roles
 * that actually authorize a site's Authentik gate (see access-policy.ts /
 * wordpress-rbac.ts). The RBAC grant is the security control (it decides who may
 * sign in and their InfraWeaver authority tier); the exact WordPress role the
 * operator chose is set separately by the signed pre-create action, so a member can
 * be, say, an `author` even though the RBAC tier is the coarser write/read verb.
 *
 * Isomorphic on purpose (no `server-only`, no Node imports): imported by the server
 * grant service, the route, and unit tests alike.
 */
import { WORDPRESS_ROLES, type WordpressRoleName } from "./capabilities";

/** The built-in InfraWeaver RBAC role ids that carry WordPress permissions. */
export type WordpressRbacRoleId = "wordpress-admin" | "wordpress-editor" | "wordpress-viewer";

/**
 * Map a chosen WordPress role to the RBAC role granted at the site scope.
 *
 * The tier is chosen by the role's WRITE capability so the RBAC grant reflects the
 * member's real authority: `administrator` → admin; publish-capable content roles
 * (`editor`, `author`) → editor (write); non-publishing roles (`contributor`,
 * `subscriber`) → viewer (read). Every mapping still confers `wordpress:read`, which
 * is the verb the Authentik gate authorizes on — so every granted user can sign in.
 *
 * NOTE: the exact chosen WordPress role is applied by the signed pre-create; this
 * mapping only governs the RBAC tier. Because the RBAC→WordPress reconcile
 * (`syncSiteWpUsers`) can only express three WordPress roles, a later reconcile may
 * normalize an `author`→`editor` or a `contributor`→`subscriber`. administrator,
 * editor and subscriber round-trip exactly.
 */
export function wpRoleToRbacRoleId(wpRole: WordpressRoleName): WordpressRbacRoleId {
  switch (wpRole) {
    case "administrator":
      return "wordpress-admin";
    case "editor":
    case "author":
      return "wordpress-editor";
    case "contributor":
    case "subscriber":
      return "wordpress-viewer";
  }
}

/** True when the chosen WordPress role confers site-administrator authority (rbac:admin gated). */
export function isAdminTierWpRole(wpRole: WordpressRoleName): boolean {
  return wpRole === "administrator";
}

/** Narrow an untrusted string to a known WordPress role, or null. */
export function asWordpressRole(value: string): WordpressRoleName | null {
  return (WORDPRESS_ROLES as readonly string[]).includes(value) ? (value as WordpressRoleName) : null;
}
