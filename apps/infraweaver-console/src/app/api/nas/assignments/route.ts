import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "nas:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("nas-assignments", req), 30, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/users.yaml`,
      {
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" },
        cache: "no-store",
      }
    );
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const file = await res.json() as { content: string; sha: string };
    const content = Buffer.from(file.content, "base64").toString("utf-8");
    const yaml = await import("js-yaml");
    const parsed = yaml.load(content) as { users?: Record<string, Record<string, unknown>> };
    const rawUsers = parsed?.users ?? {};
    const assignments = Object.entries(rawUsers).map(([username, data]) => ({
      username,
      name: (data.name as string) ?? username,
      nas_shares: (data.nas_shares as unknown[]) ?? [],
    }));
    return NextResponse.json({ assignments });
  } catch (e) {
    console.error("Failed to fetch assignments:", e);
    return NextResponse.json({ assignments: [] });
  }
}
