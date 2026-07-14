import { findUserByUsername, findUserByEmail } from "@/lib/authentik";

/**
 * The subset of an Authentik user record the lifecycle code depends on. Kept
 * permissive on purpose — the serializer returns more, but offboard/delete only
 * needs the pk (for the /core/users/<pk>/ mutation), and reconcile reads the
 * canonical username. `findUserBy*` returns the raw record, which is assignable.
 */
export interface AuthentikUserRecord {
  pk: number | string;
  username?: string;
  email?: string;
  groups?: unknown[];
  is_active?: boolean;
}

export interface IdentityResolvers {
  findUserByUsername: (username: string) => Promise<AuthentikUserRecord | null>;
  findUserByEmail: (email: string) => Promise<AuthentikUserRecord | null>;
}

/**
 * Resolve the Authentik identity for a roster user: match by username first,
 * then fall back to the roster email.
 *
 * The email fallback is load-bearing. A username/case drift — or a post-invite
 * rename — leaves an Authentik record that the username lookup can no longer see
 * but that plainly exists under its (unchanged) email. Without the fallback,
 * offboard/delete silently skips the SSO account and ORPHANS the identity (access
 * never revoked), and reconcile re-invites a user who already enrolled. The pk
 * this returns is exactly what offboard feeds into `DELETE /core/users/<pk>/`, so
 * resolving the email-matched record here is what makes the delete actually land.
 *
 * `resolvers` is injectable so this precise fallback is exercised deterministically
 * in unit tests and the runtime self-test (`/api/test-suite`) without a live
 * Authentik. It defaults to the real lookups.
 */
export async function resolveAuthentikIdentity(
  username: string,
  rosterEmail: string | undefined,
  resolvers: IdentityResolvers = { findUserByUsername, findUserByEmail },
): Promise<AuthentikUserRecord | null> {
  return (
    (await resolvers.findUserByUsername(username)) ??
    (rosterEmail ? await resolvers.findUserByEmail(rosterEmail) : null)
  );
}

/**
 * The username under which a user's LOCAL app accounts (Jellyfin, Nextcloud) live.
 *
 * App accounts are always created under the CANONICAL Authentik username — the name
 * the person chose at enrollment — never the (possibly hand-entered, possibly drifted)
 * users.yaml / route key. So provisioning AND deprovisioning MUST key off the SAME
 * canonical name: reconcile creates them under `identity.username`, so offboard must
 * delete them under `identity.username` too, or a username/case drift orphans the
 * local login and its stored credential (the SSO account is torn down, the app
 * accounts leak forever). Falls back to `fallbackKey` only when there is no SSO
 * identity (a local-only user), which is the only name they could have been created
 * under. This is the shared seam so reconcile's provision key and offboard's
 * deprovision key can never diverge.
 */
export function canonicalAppUsername(
  identity: AuthentikUserRecord | null,
  fallbackKey: string,
): string {
  return identity && typeof identity.username === "string" && identity.username
    ? identity.username
    : fallbackKey;
}
