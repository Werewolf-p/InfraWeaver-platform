import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { auditLog } from "@/lib/audit-log";
import { safeError } from "@/lib/utils";

const usersConfigPostSchema = z.object({
  users: z.array(z.record(z.string(), z.unknown())).min(1),
  sha: z.string().optional(),
  commitMessage: z.string().optional(),
});

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

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "users:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const file = await getFileFromGitHub();
    const content = Buffer.from(file.content, "base64").toString("utf-8");
    const yaml = await import("js-yaml");
    const parsed = yaml.load(content) as { users?: Record<string, Record<string, unknown>> | unknown[] };
    // users.yaml stores users as a keyed object { remon: {...}, ardaty: {...} }
    // Normalize to array with username injected
    const rawUsers = parsed?.users ?? {};
    let usersArray: Record<string, unknown>[];
    if (Array.isArray(rawUsers)) {
      usersArray = rawUsers as Record<string, unknown>[];
    } else {
      usersArray = Object.entries(rawUsers).map(([username, data]) => ({
        username,
        ...(data as Record<string, unknown>),
      }));
    }
    return NextResponse.json({ users: usersArray, sha: file.sha, raw: content });
  } catch {
    return NextResponse.json({
      users: [
        { username: "admin", name: "Administrator", email: "admin@rlservers.com", access_level: "admin", wiki_role: "admin", authentik_groups: ["platform-admins", "platform-users"], argocd_role: "role:admin" },
        { username: "operator", name: "Operator User", email: "operator@rlservers.com", access_level: "platform-user", wiki_role: "editor", authentik_groups: ["platform-operators", "platform-users"], argocd_role: "role:operator" },
      ],
      sha: "",
      raw: "",
    });
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "users:write")) {
    return NextResponse.json({ error: "Forbidden: admin required" }, { status: 403 });
  }

  if (!checkRateLimit(rateLimitKey("users-config-post", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const rawBody = await req.json().catch(() => ({}));
    const parsed = usersConfigPostSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
    }
    const body = parsed.data;
    let sha = body.sha;
    if (!sha) {
      const file = await getFileFromGitHub();
      sha = file.sha;
    }
    const yaml = await import("js-yaml");
    // Convert array back to keyed object for YAML storage
    const usersObj = (body.users as Array<Record<string, unknown>>).reduce<Record<string, Record<string, unknown>>>((acc, u) => {
      const { username, ...rest } = u;
      acc[username as string] = rest;
      return acc;
    }, {});
    const newContent = yaml.dump({ users: usersObj }, { lineWidth: -1, indent: 2 });
    const commitMessage = body.commitMessage ?? "chore: update users.yaml via InfraWeaver Console";
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
    await auditLog(
      "users-config:write",
      session.user?.email ?? "unknown",
      `Updated users.yaml — ${(body.users as unknown[]).length} user(s)`
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
