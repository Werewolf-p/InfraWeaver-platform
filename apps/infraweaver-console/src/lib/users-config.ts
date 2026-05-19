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

export interface LoadedUsersConfig {
  users: Record<string, UsersConfigUser>;
  sha: string;
  raw: string;
}

export async function loadUsersConfig(revalidateSeconds = 0): Promise<LoadedUsersConfig> {
  if (!getGitAccessToken().trim()) throw new Error("Git provider token is not configured");
  const file = await gitReadFile(USERS_FILE_PATH, revalidateSeconds);
  if (!file) throw new Error("users.yaml not found");
  const raw = file.content;
  const parsed = load(raw) as { users?: Record<string, UsersConfigUser> | UsersConfigUser[] };
  const users = Array.isArray(parsed?.users)
    ? Object.fromEntries((parsed.users ?? []).map((user) => [String((user as Record<string, unknown>).username ?? ""), user]))
    : (parsed?.users ?? {});
  return { users, sha: file.sha, raw };
}

export async function saveUsersConfig(users: Record<string, UsersConfigUser>, sha: string, commitMessage: string) {
  const content = dump({ users }, { lineWidth: -1, indent: 2 });
  await gitWriteFile(USERS_FILE_PATH, content, commitMessage, sha);
}

export function normalizeRoleAssignments(username: string, assignments: RoleAssignment[] = []): RoleAssignment[] {
  return assignments.map((assignment) => ({
    ...assignment,
    principalType: assignment.principalType ?? "user",
    principalId: assignment.principalId ?? username,
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
