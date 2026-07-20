/**
 * People (Users) panel probe — the site's WordPress accounts with their id, login,
 * display name, email, roles and registration date, read live over core `wp-cli`
 * (WP_SAFE). The `id` powers the Users panel's action UI (every user action —
 * update role/email, set/reset password, delete — is keyed by user id). Per-role
 * headcounts are computed EXACTLY over the whole site (one count query per
 * allow-listed role), independent of the bounded row list.
 *
 * BOUNDING (durable-snapshot safety): the row list is capped at USER_LIST_LIMIT so
 * a membership site with thousands of accounts never snapshots thousands of rows.
 * `total` is the exact count; when it exceeds the returned rows the UI live-fetches
 * more on demand. This keeps a Users snapshot comfortably under the 16 KB per-panel
 * ConfigMap bound.
 *
 * The one mutation historically offered here, "Reconcile accounts", routes through
 * the allow-listed `sync-users` Manage action — the panel's write actions are the
 * allow-listed Manage actions, never driven from this read probe.
 */
import { WP_SAFE, kvLine, parseKv, parseJsonArray, toInt, fieldStr, fieldNum } from "../wp-probe";
import { WORDPRESS_ROLES } from "../capabilities";
import type { PanelProbe, PanelProbeContext } from "./contract";

/** How many user rows the panel list is bounded to (exact total is reported separately). */
export const USER_LIST_LIMIT = 100;

export interface WpUserRow {
  readonly id: number;
  readonly login: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly roles: readonly string[];
  readonly registered: string | null;
  /**
   * Last sign-in, when a tracking plugin records it. WordPress core does NOT store
   * last-login, so this is null unless the site runs a plugin that populates it;
   * the action UI shows it best-effort.
   */
  readonly lastLogin: string | null;
}

export interface RoleCount {
  readonly role: string;
  readonly count: number;
}

export interface PeopleData {
  /** The first USER_LIST_LIMIT accounts (bounded for the durable snapshot). */
  readonly users: readonly WpUserRow[];
  /** Exact per-role headcounts over the whole site. */
  readonly roleCounts: readonly RoleCount[];
  /** Exact total account count (may exceed `users.length`). */
  readonly total: number;
  /** The row bound applied to `users` — the UI live-fetches more when total > limit. */
  readonly limit: number;
}

type UserRow = {
  ID?: number | string;
  user_login?: string;
  display_name?: string;
  user_email?: string;
  roles?: unknown;
  user_registered?: string;
};

/** wp-cli reports `roles` as a comma-joined string; tolerate an array too. */
function parseRoles(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((r): r is string => typeof r === "string").map((r) => r.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);
  }
  return [];
}

export function parsePeople(input: { users: string; counts: string; total: string }): PeopleData {
  const users: WpUserRow[] = parseJsonArray<UserRow>(input.users)
    .slice(0, USER_LIST_LIMIT)
    .map((row) => ({
      id: fieldNum(row, "ID") ?? 0,
      login: fieldStr(row, "user_login") ?? "unknown",
      displayName: fieldStr(row, "display_name") ?? fieldStr(row, "user_login") ?? "unknown",
      email: fieldStr(row, "user_email"),
      roles: parseRoles(row.roles),
      registered: fieldStr(row, "user_registered"),
      lastLogin: null,
    }));

  // Exact per-role headcounts over the whole site (not the bounded sample).
  const kv = parseKv(input.counts);
  const roleCounts: RoleCount[] = WORDPRESS_ROLES.map((role) => ({
    role,
    count: toInt(kv.get(`ROLE_${role}`)) ?? 0,
  }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);

  const total = toInt(input.total.trim()) ?? users.length;

  return { users, roleCounts, total, limit: USER_LIST_LIMIT };
}

async function fetchPeople(ctx: PanelProbeContext): Promise<PeopleData> {
  // One shell batch for the exact per-role counts; a bounded row list; an exact total.
  const countsCmd = WORDPRESS_ROLES.map((role) =>
    kvLine(`ROLE_${role}`, `${WP_SAFE} user list --role=${role} --format=count`),
  ).join("\n");

  const [users, counts, total] = await Promise.all([
    ctx
      .exec(
        `${WP_SAFE} user list --fields=ID,user_login,display_name,user_email,roles,user_registered --number=${USER_LIST_LIMIT} --format=json`,
      )
      .then((r) => r.stdout)
      .catch(() => "[]"),
    ctx.exec(countsCmd).then((r) => r.stdout).catch(() => ""),
    ctx.exec(`${WP_SAFE} user list --format=count`).then((r) => r.stdout).catch(() => "0"),
  ]);

  return parsePeople({ users, counts, total });
}

export const peopleProbe: PanelProbe<PeopleData> = {
  id: "people",
  fetch: fetchPeople,
};
