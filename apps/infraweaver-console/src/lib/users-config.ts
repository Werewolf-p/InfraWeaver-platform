import { dump, load } from "js-yaml";
import type { Session } from "next-auth";
import { getGitAccessToken, gitReadFile, gitWriteFile } from "@/lib/git-provider";
import type { RoleAssignment } from "@/lib/rbac";

const USERS_FILE_PATH = "users.yaml";

export interface UsersConfigUser extends Record<string, unknown> {
  name?: string;
  email?: string;
  authentik_groups?: string[];
  role_assignments?: RoleAssignment[];
}

/**
 * A top-level Authentik group entry in users.yaml. Role assignments stored here
 * target the GROUP as principal (principalType "group", principalId = groupName)
 * so `getEffectivePermissions`' group filter resolves them for every member.
 */
export interface UsersConfigGroup extends Record<string, unknown> {
  role_assignments?: RoleAssignment[];
}

export interface LoadedUsersConfig {
  users: Record<string, UsersConfigUser>;
  groups: Record<string, UsersConfigGroup>;
  sha: string;
  raw: string;
}

export async function loadUsersConfig(revalidateSeconds = 0): Promise<LoadedUsersConfig> {
  if (!getGitAccessToken().trim()) throw new Error("Git provider token is not configured");
  const file = await gitReadFile(USERS_FILE_PATH, revalidateSeconds);
  if (!file) throw new Error("users.yaml not found");
  const raw = file.content;
  const parsed = load(raw) as {
    users?: Record<string, UsersConfigUser> | UsersConfigUser[];
    groups?: Record<string, UsersConfigGroup>;
  };
  const users = Array.isArray(parsed?.users)
    ? Object.fromEntries((parsed.users ?? []).map((user) => [String((user as Record<string, unknown>).username ?? ""), user]))
    : (parsed?.users ?? {});
  const groups = parsed?.groups && !Array.isArray(parsed.groups) ? parsed.groups : {};
  return { users, groups, sha: file.sha, raw };
}

/**
 * Persists the users config. `groups` is optional for back-compat: callers that
 * only mutate users omit it and the current `groups:` section is preserved
 * (re-read at save time) so a plain user edit never wipes group assignments.
 */
export async function saveUsersConfig(
  users: Record<string, UsersConfigUser>,
  sha: string,
  commitMessage: string,
  groups?: Record<string, UsersConfigGroup>,
) {
  const resolvedGroups = groups ?? (await loadUsersConfig(0).then((c) => c.groups).catch(() => ({})));
  const payload: { users: Record<string, UsersConfigUser>; groups?: Record<string, UsersConfigGroup> } = { users };
  if (Object.keys(resolvedGroups).length > 0) payload.groups = resolvedGroups;
  const content = dump(payload, { lineWidth: -1, indent: 2 });
  await gitWriteFile(USERS_FILE_PATH, content, commitMessage, sha);
}

export function normalizeRoleAssignments(username: string, assignments: RoleAssignment[] = []): RoleAssignment[] {
  return assignments.map((assignment) => ({
    ...assignment,
    principalType: assignment.principalType ?? "user",
    principalId: assignment.principalId ?? username,
  }));
}

/** Normalizes a group's stored assignments so each names the GROUP as principal. */
export function normalizeGroupRoleAssignments(groupName: string, assignments: RoleAssignment[] = []): RoleAssignment[] {
  return assignments.map((assignment) => ({
    ...assignment,
    principalType: "group" as const,
    principalId: groupName,
  }));
}

export function findUserByIdentity(
  users: Record<string, UsersConfigUser>,
  identity: { username?: string; email?: string }
): { username: string; user: UsersConfigUser } | null {
  if (identity.username && users[identity.username]) {
    return { username: identity.username, user: users[identity.username] };
  }
  if (identity.email) {
    const match = Object.entries(users).find(([, user]) => user.email === identity.email);
    if (match) return { username: match[0], user: match[1] };
  }
  return null;
}

export async function getRoleAssignmentsForSession(session: Session | null, revalidateSeconds = 0) {
  if (!session) return { username: "", roleAssignments: [] as RoleAssignment[] };
  const loaded = await loadUsersConfig(revalidateSeconds);
  const match = findUserByIdentity(loaded.users, {
    username: (session.user as { username?: string } | undefined)?.username,
    email: session.user?.email ?? undefined,
  });
  return {
    username: match?.username ?? "",
    roleAssignments: normalizeRoleAssignments(match?.username ?? "", match?.user.role_assignments),
  };
}

/**
 * Every role assignment granted to the session's Authentik groups, each
 * normalized to name the group as principal. Merged into the session's role
 * assignments so `getEffectivePermissions`' group filter resolves them for
 * every member (the fix for group principals previously stored under a username).
 */
export async function getGroupRoleAssignmentsForSession(
  session: Session | null,
  revalidateSeconds = 0,
): Promise<RoleAssignment[]> {
  if (!session) return [];
  const groups: string[] = (session.user as { groups?: string[] } | undefined)?.groups ?? [];
  if (groups.length === 0) return [];
  const loaded = await loadUsersConfig(revalidateSeconds);
  const out: RoleAssignment[] = [];
  for (const groupName of groups) {
    const group = loaded.groups[groupName];
    if (!group?.role_assignments) continue;
    out.push(...normalizeGroupRoleAssignments(groupName, group.role_assignments));
  }
  return out;
}
