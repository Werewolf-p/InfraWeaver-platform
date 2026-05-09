import { NextRequest, NextResponse } from "next/server";

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
  try {
    const body = await req.json() as { users: unknown[]; commitMessage?: string; sha?: string };
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
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
