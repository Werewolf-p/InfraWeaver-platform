/**
 * Client-side field validators for the Manage console's action forms. These
 * MIRROR the server's zod schemas in lib/manage/actions.ts exactly — the server
 * is the source of truth and re-validates everything, so these only exist to give
 * fast, inline feedback before a request is sent. Pure and dependency-free so they
 * can be unit-tested in isolation and reused across every action form.
 */

/** wp.org slug: lowercase alphanumeric + dashes, 1..64. */
export function isValidSlug(value: string): boolean {
  return value.length >= 1 && value.length <= 64 && /^[a-z0-9-]+$/.test(value);
}

/** WordPress login: 1..60, alphanumeric bookends, `._-` allowed inside. */
export function isValidLogin(value: string): boolean {
  return value.length >= 1 && value.length <= 60 && /^[a-z0-9](?:[a-z0-9._-]{0,58}[a-z0-9])?$/i.test(value);
}

/** Standard email shape, max 254 chars (matches the server regex). */
export function isValidEmail(value: string): boolean {
  return value.length <= 254 && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value);
}

/** Password: 8..200 chars, no line breaks. */
export function isValidPassword(value: string): boolean {
  return value.length >= 8 && value.length <= 200 && !/[\n\r]/.test(value);
}

/** Allow-listed site-option value: max 500 chars, no line breaks. */
export function isValidOptionValue(value: string): boolean {
  return value.length <= 500 && !/[\n\r]/.test(value);
}

/** A positive integer id (WordPress post/user/comment ids). */
export function isPositiveIntId(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/** Parse a user-typed id string to a positive int, or null when invalid. */
export function parseId(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return isPositiveIntId(n) ? n : null;
}

/**
 * Whether a typed-confirmation input matches the required phrase. Trimmed on both
 * sides and compared case-SENSITIVELY — the phrase is shown verbatim, so an exact
 * echo is the intent. Used to arm destructive actions (delete user/post/theme).
 */
export function confirmationMatches(input: string, required: string): boolean {
  return input.trim() === required.trim() && required.trim().length > 0;
}
