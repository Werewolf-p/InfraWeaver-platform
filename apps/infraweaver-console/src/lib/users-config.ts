import { dump, load } from "js-yaml";
import type { Session } from "next-auth";
import type { RoleAssignment } from "@/lib/rbac";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";
const USERS_FILE_PATH = "users.yaml";

export interface UsersConfigUser extends Record<string, unknown> {
  name?: string;
  email?: string;
  role_assignments?: RoleAssignment[];
}

export interface LoadedUsersConfig {
  users: Record<string, UsersConfigUser>;
  sha: string;
  raw: string;
}

function githubHeaders() {
  return {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github.v3+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function loadUsersConfig(revalidateSeconds = 0): Promise<LoadedUsersConfig> {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${USERS_FILE_PATH}`,
    revalidateSeconds > 0
      ? { headers: githubHeaders(), next: { revalidate: revalidateSeconds } }
      : { headers: githubHeaders(), cache: "no-store" }
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  const file = await res.json() as { content: string; sha: string };
  const raw = Buffer.from(file.content, "base64").toString("utf-8");
  const parsed = load(raw) as { users?: Record<string, UsersConfigUser> | UsersConfigUser[] };
  const users = Array.isArray(parsed?.users)
    ? Object.fromEntries((parsed.users ?? []).map((user) => [String((user as Record<string, unknown>).username ?? ""), user]))
    : (parsed?.users ?? {});
  return { users, sha: file.sha, raw };
}

export async function saveUsersConfig(users: Record<string, UsersConfigUser>, sha: string, commitMessage: string) {
  const content = dump({ users }, { lineWidth: -1, indent: 2 });
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${USERS_FILE_PATH}`, {
    method: "PUT",
    headers: {
      ...githubHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: commitMessage,
      content: Buffer.from(content).toString("base64"),
      sha,
      committer: { name: "InfraWeaver Console", email: "console@infraweaver.internal" },
    }),
  });
  if (!res.ok) throw new Error(`GitHub PUT failed: ${await res.text()}`);
  return res.json();
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
