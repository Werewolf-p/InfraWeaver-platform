import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { auditLog } from "@/lib/audit-log";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

// Authentik username: alphanumeric, dots, hyphens, underscores, @-sign
const SAFE_USERNAME_RE = /^[\w.@+-]{1,150}$/;

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";
const USERS_FILE_PATH = "users.yaml";

async function getFileFromGitHub() {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${USERS_FILE_PATH}`,
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    }
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  return res.json();
}

async function saveUsersToGitHub(
  usersObj: Record<string, Record<string, unknown>>,
  sha: string,
  commitMessage: string
) {
  const yaml = await import("js-yaml");
  const newContent = yaml.dump({ users: usersObj }, { lineWidth: -1, indent: 2 });
  const updateRes = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${USERS_FILE_PATH}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: commitMessage,
        content: Buffer.from(newContent).toString("base64"),
        sha,
        committer: { name: "InfraWeaver Console", email: "console@infraweaver.internal" },
      }),
    }
  );
  if (!updateRes.ok) {
    const errText = await updateRes.text();
    throw new Error(`GitHub PUT failed: ${errText}`);
  }
  return updateRes.json();
}

// PUT /api/users-config/[username] — update single user
export async function PUT(req: NextRequest, { params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!SAFE_USERNAME_RE.test(username)) {
    return NextResponse.json({ error: "Invalid username" }, { status: 400 });
  }
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "users:write")) {
    return NextResponse.json({ error: "Forbidden: admin required" }, { status: 403 });
  }

  if (!checkRateLimit(rateLimitKey("users-config-put", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const body = await req.json() as Record<string, unknown>;
    const file = await getFileFromGitHub();
    const yaml = await import("js-yaml");
    const content = Buffer.from(file.content, "base64").toString("utf-8");
    const parsed = yaml.load(content) as { users?: Record<string, Record<string, unknown>> };
    const rawUsers = (parsed?.users ?? {}) as Record<string, Record<string, unknown>>;

    if (!rawUsers[username]) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Self-lockout prevention: if changing own role from admin and no other admins remain
    const currentUser = session.user as { email?: string; name?: string };
    const selfUsername = Object.entries(rawUsers).find(([, u]) => u.email === currentUser.email)?.[0];
    if (selfUsername === username && body.access_level && body.access_level !== "admin") {
      const otherAdmins = Object.entries(rawUsers).filter(
        ([uname, u]) => uname !== username && u.access_level === "admin"
      );
      if (otherAdmins.length === 0) {
        return NextResponse.json(
          { error: "Cannot remove admin role: you are the last admin" },
          { status: 400 }
        );
      }
    }

    const { username: _u, ...rest } = body as { username?: string } & Record<string, unknown>;
    rawUsers[username] = { ...rawUsers[username], ...rest };

    await saveUsersToGitHub(rawUsers, file.sha, `chore: update user ${username} via InfraWeaver Console`);
    await auditLog("users-config:update", currentUser.email ?? "unknown", `Updated user ${username}`);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

// DELETE /api/users-config/[username] — delete single user
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ username: string }> }) {
  const { username } = await params;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!SAFE_USERNAME_RE.test(username)) {
    return NextResponse.json({ error: "Invalid username" }, { status: 400 });
  }
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "users:write")) {
    return NextResponse.json({ error: "Forbidden: admin required" }, { status: 403 });
  }

  if (!checkRateLimit(rateLimitKey("users-config-delete", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const file = await getFileFromGitHub();
    const yaml = await import("js-yaml");
    const content = Buffer.from(file.content, "base64").toString("utf-8");
    const parsed = yaml.load(content) as { users?: Record<string, Record<string, unknown>> };
    const rawUsers = (parsed?.users ?? {}) as Record<string, Record<string, unknown>>;

    if (!rawUsers[username]) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Self-deletion prevention
    const currentUser = session.user as { email?: string; name?: string };
    const selfUsername = Object.entries(rawUsers).find(([, u]) => u.email === currentUser.email)?.[0];
    if (selfUsername === username) {
      return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
    }

    // Last admin prevention
    const isAdmin = rawUsers[username]?.access_level === "admin";
    if (isAdmin) {
      const remainingAdmins = Object.entries(rawUsers).filter(
        ([uname, u]) => uname !== username && u.access_level === "admin"
      );
      if (remainingAdmins.length === 0) {
        return NextResponse.json(
          { error: "Cannot delete the last admin account" },
          { status: 400 }
        );
      }
    }

    delete rawUsers[username];
    await saveUsersToGitHub(rawUsers, file.sha, `chore: delete user ${username} via InfraWeaver Console`);
    await auditLog("users-config:delete", currentUser.email ?? "unknown", `Deleted user ${username}`);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
