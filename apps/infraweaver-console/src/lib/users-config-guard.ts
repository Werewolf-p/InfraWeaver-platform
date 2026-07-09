/**
 * Guards for the generic user create/edit paths (C1, SECURITY-SCAN-2026-07-08).
 *
 * `role_assignments`, `authentik_groups`, and `access_level` all confer
 * authorization. Letting a `users:write` actor set them through the generic
 * user PUT / bulk POST bypasses the grant privilege-ceiling
 * (`assignmentExceedsGranter`) — an actor with `users:write` (e.g. the built-in
 * `platform-admin`, which does NOT hold "*") could PUT their own record with a
 * `platform-owner` role assignment and escalate to Owner.
 *
 * These fields must only change through the ceiling-checked RBAC endpoints
 * (`grantRoleAssignment` / `revokeRoleAssignment`). This module is intentionally
 * free of server-only / IO imports so it can be unit-tested directly.
 */

/** Authorization-conferring fields forbidden on the generic user edit paths. */
export const PRIVILEGED_USER_FIELDS = ["role_assignments", "authentik_groups", "access_level"] as const;

export type PrivilegedUserField = (typeof PRIVILEGED_USER_FIELDS)[number];

/** Least-privilege authorization defaults applied to a brand-new bulk-created user. */
export const DEFAULT_USER_PRIVILEGES: Readonly<Record<string, unknown>> = { access_level: "viewer" };

/**
 * The privileged fields present as own keys on `body`. An explicit `undefined`
 * value still counts as present, so a client spreading a full record with
 * `access_level: undefined` cannot slip past the check.
 */
export function findPrivilegedFields(body: Record<string, unknown>): PrivilegedUserField[] {
  return PRIVILEGED_USER_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
}

const PRIVILEGED_SET: ReadonlySet<string> = new Set(PRIVILEGED_USER_FIELDS);

/**
 * Sanitize an incoming bulk-save user record: drop any privileged fields from
 * the request and re-apply them from the stored record (or safe defaults for a
 * new user), so a bulk `users:write` can never mutate authorization state.
 * Non-privileged profile fields (name, email, wiki_role, …) pass through.
 * Returns a new object; inputs are not mutated.
 */
export function preservePrivilegedFields(
  incoming: Record<string, unknown>,
  stored?: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (PRIVILEGED_SET.has(key)) continue;
    result[key] = value;
  }
  const source = stored ?? DEFAULT_USER_PRIVILEGES;
  for (const field of PRIVILEGED_USER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      result[field] = source[field];
    }
  }
  return result;
}
