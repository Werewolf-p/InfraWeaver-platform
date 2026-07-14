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
