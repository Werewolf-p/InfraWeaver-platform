import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { auditLog } from "@/lib/audit-log";
import { loadUsersConfig, saveUsersConfig } from "@/lib/users-config";
import { safeError } from "@/lib/utils";

const usersConfigPostSchema = z.object({
  users: z.array(z.record(z.string(), z.unknown())).min(1),
  sha: z.string().optional(),
  commitMessage: z.string().optional(),
});


export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "users:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const { users, sha, raw } = await loadUsersConfig();
    const usersArray = Object.entries(users).map(([username, data]) => ({
      username,
      ...(data as Record<string, unknown>),
    }));
    return NextResponse.json({ users: usersArray, sha, raw });
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
      ({ sha } = await loadUsersConfig());
    }
    // Convert array back to keyed object for YAML storage
    const usersObj = (body.users as Array<Record<string, unknown>>).reduce<Record<string, Record<string, unknown>>>((acc, u) => {
      const { username, ...rest } = u;
      acc[username as string] = rest;
      return acc;
    }, {});
    const commitMessage = body.commitMessage ?? "chore: update users.yaml via InfraWeaver Console";
    await saveUsersConfig(usersObj, sha, commitMessage);
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
