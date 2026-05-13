import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { findUserByUsername, authentikFetch } from "@/lib/authentik";
import { auditLog } from "@/lib/audit-log";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";
const USERS_FILE_PATH = "users.yaml";

async function getGitHubFile() {
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

async function updateGitHubFile(content: string, sha: string, message: string) {
  const res = await fetch(
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
        message,
        content: Buffer.from(content).toString("base64"),
        sha,
        committer: { name: "InfraWeaver Console", email: "console@infraweaver.internal" },
      }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PUT failed: ${text}`);
  }
  return res.json();
}

const USERNAME_RE = /^[a-z0-9.-]{3,32}$/;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ username: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["users:invite", "users:write", "rbac:admin"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { username } = await params;
  const { newUsername } = await req.json() as { newUsername: string };

  if (!newUsername || !USERNAME_RE.test(newUsername)) {
    return NextResponse.json({ error: "Invalid username (3-32 chars, a-z0-9.-)" }, { status: 400 });
  }

  const user = await findUserByUsername(username);
  if (!user) return NextResponse.json({ error: "User not found in Authentik" }, { status: 404 });

  const selfEmail = (session.user as { email?: string }).email ?? "";
  if (user.email === selfEmail) {
    return NextResponse.json({ error: "Cannot rename yourself" }, { status: 400 });
  }

  const r = await authentikFetch(`/core/users/${user.pk}/`, {
    method: "PATCH",
    body: JSON.stringify({ username: newUsername }),
  });
  if (!r.ok) return NextResponse.json({ error: "Authentik update failed" }, { status: 502 });

  try {
    const file = await getGitHubFile();
    const yaml = await import("js-yaml");
    const parsed = yaml.load(Buffer.from(file.content, "base64").toString("utf-8")) as {
      users?: Record<string, Record<string, unknown>>;
    };
    if (parsed?.users?.[username]) {
      const userData = parsed.users[username];
      delete parsed.users[username];
      parsed.users[newUsername] = userData;
      const newContent = yaml.dump({ users: parsed.users }, { lineWidth: -1, indent: 2 });
      await updateGitHubFile(
        newContent,
        file.sha,
        `chore: rename user ${username} → ${newUsername}`
      );
    }
  } catch {
    // Non-fatal
  }

  await auditLog(
    "users:change-username",
    session.user?.email ?? "unknown",
    `Renamed ${username} to ${newUsername}`
  );
  return NextResponse.json({ ok: true });
}
