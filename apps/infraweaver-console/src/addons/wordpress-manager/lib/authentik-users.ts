import "server-only";
import { authentikFetch } from "@/lib/authentik";

/**
 * Read-only listing of existing Authentik users for the "grant existing user"
 * picker. This is the directory the operator chooses from; the chosen user's
 * canonical email is what the site's OIDC plugin links the pre-created WordPress
 * account to on first sign-in (identity_key = "email"). We never trust a
 * client-supplied email — the grant path re-resolves the user by username here.
 */

/** The subset of an Authentik user record the picker + grant path need. */
export interface AuthentikUserSummary {
  readonly username: string;
  readonly email: string;
  readonly name: string;
}

/** The raw Authentik `/core/users/` row shape (all fields untrusted/optional). */
interface AuthentikUserRow {
  username?: unknown;
  email?: unknown;
  name?: unknown;
  is_active?: unknown;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Shape + filter raw Authentik rows into picker summaries: only active users that
 * carry BOTH a username and an email (an account with no email can't be linked by
 * the OIDC email identity key, so it can't be pre-created). Pure + exported so the
 * mapping is unit-testable without a live Authentik.
 */
export function mapAuthentikUsers(rows: readonly unknown[]): AuthentikUserSummary[] {
  return rows
    .flatMap((row): AuthentikUserSummary[] => {
      const r = row as AuthentikUserRow;
      if (r.is_active === false) return [];
      const username = str(r.username);
      const email = str(r.email);
      if (!username || !email) return [];
      return [{ username, email, name: str(r.name) || username }];
    })
    .sort((a, b) => a.username.localeCompare(b.username));
}

/** How many picker results we ever return (server-side search keeps this small). */
export const AUTHENTIK_USER_PAGE_SIZE = 25;

/**
 * List/search active Authentik users for the picker. `query` is passed to
 * Authentik's server-side `?search=` (matches username/email/name); an empty query
 * returns the first page. Returns [] on any Authentik error rather than throwing so
 * the picker degrades to "no matches" instead of a 500 — the grant path re-resolves
 * and fails loudly if the chosen user has since vanished.
 */
export async function listAuthentikUsers(query: string, limit = AUTHENTIK_USER_PAGE_SIZE): Promise<AuthentikUserSummary[]> {
  const params = new URLSearchParams({
    page_size: String(Math.min(Math.max(limit, 1), AUTHENTIK_USER_PAGE_SIZE)),
    is_active: "true",
  });
  const trimmed = query.trim();
  if (trimmed) params.set("search", trimmed);
  let res: Response;
  try {
    res = await authentikFetch(`/core/users/?${params.toString()}`);
  } catch {
    return [];
  }
  if (!res.ok) return [];
  const body = (await res.json().catch(() => null)) as { results?: unknown[] } | null;
  return mapAuthentikUsers(body?.results ?? []).slice(0, limit);
}

/**
 * Resolve a single Authentik user by exact username, returning the canonical
 * email + display name — the authoritative source for the pre-create, so a
 * client can never inject a different email than the account it named. Returns
 * null when the username is unknown (or Authentik is unreachable).
 */
export async function resolveAuthentikUser(username: string): Promise<AuthentikUserSummary | null> {
  let res: Response;
  try {
    res = await authentikFetch(`/core/users/?username=${encodeURIComponent(username)}`);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { results?: unknown[] } | null;
  const mapped = mapAuthentikUsers(body?.results ?? []);
  return mapped.find((u) => u.username === username) ?? null;
}
