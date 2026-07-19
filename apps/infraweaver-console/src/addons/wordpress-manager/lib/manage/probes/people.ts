/**
 * People (Users) panel probe — the site's WordPress accounts with their roles and
 * registration date, read live over core `wp-cli` (WP_SAFE), plus a per-role
 * headcount computed here. The one mutation this panel offers, "Reconcile
 * accounts", routes through the allow-listed `sync-users` Manage action — it is
 * not driven from this probe.
 */
import { WP_SAFE, parseJsonArray, fieldStr } from "../wp-probe";
import type { PanelProbe, PanelProbeContext } from "./contract";

export interface WpUserRow {
  readonly login: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly roles: readonly string[];
  readonly registered: string | null;
}

export interface RoleCount {
  readonly role: string;
  readonly count: number;
}

export interface PeopleData {
  readonly users: readonly WpUserRow[];
  readonly roleCounts: readonly RoleCount[];
  readonly total: number;
}

type UserRow = {
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

export function parsePeople(input: { users: string }): PeopleData {
  const users: WpUserRow[] = parseJsonArray<UserRow>(input.users).map((row) => ({
    login: fieldStr(row, "user_login") ?? "unknown",
    displayName: fieldStr(row, "display_name") ?? fieldStr(row, "user_login") ?? "unknown",
    email: fieldStr(row, "user_email"),
    roles: parseRoles(row.roles),
    registered: fieldStr(row, "user_registered"),
  }));

  const counts = new Map<string, number>();
  for (const user of users) {
    const roles = user.roles.length > 0 ? user.roles : ["none"];
    for (const role of roles) counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  const roleCounts: RoleCount[] = [...counts.entries()]
    .map(([role, count]) => ({ role, count }))
    .sort((a, b) => b.count - a.count);

  return { users, roleCounts, total: users.length };
}

async function fetchPeople(ctx: PanelProbeContext): Promise<PeopleData> {
  const users = await ctx
    .exec(`${WP_SAFE} user list --fields=user_login,display_name,user_email,roles,user_registered --format=json`)
    .then((r) => r.stdout)
    .catch(() => "[]");

  return parsePeople({ users });
}

export const peopleProbe: PanelProbe<PeopleData> = {
  id: "people",
  fetch: fetchPeople,
};
