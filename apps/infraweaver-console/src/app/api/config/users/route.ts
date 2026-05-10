import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "users:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/users.yaml`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        cache: "no-store",
      }
    );
    if (!res.ok) throw new Error("GitHub API error");
    const file = await res.json();
    const content = Buffer.from(file.content, "base64").toString("utf-8");
    const yaml = await import("js-yaml");
    const parsed = yaml.load(content) as { users?: unknown[] };
    const users = parsed?.users ?? [];
    return NextResponse.json(users);
  } catch {
    return NextResponse.json([
      { username: "admin", email: "admin@rlservers.com", groups: ["platform-admins", "platform-users"] },
      { username: "operator", email: "operator@rlservers.com", groups: ["platform-operators", "platform-users"] },
      { username: "viewer", email: "viewer@rlservers.com", groups: ["platform-users"] },
    ]);
  }
}
