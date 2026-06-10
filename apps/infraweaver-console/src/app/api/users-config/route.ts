import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/with-auth";
import { auditLog } from "@/lib/audit-log";
import { loadUsersConfig, saveUsersConfig } from "@/lib/users-config";
import { BASE_DOMAIN } from "@/lib/domain";

const usersConfigPostSchema = z.object({
  users: z.array(z.record(z.string(), z.unknown())).min(1),
  sha: z.string().optional(),
  commitMessage: z.string().optional(),
});

export const GET = withAuth({ permission: "users:read" }, async () => {
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
        { username: "admin", name: "Administrator", email: `admin@${BASE_DOMAIN}`, access_level: "admin", wiki_role: "admin", authentik_groups: ["platform-admins", "platform-users"], argocd_role: "role:admin" },
        { username: "operator", name: "Operator User", email: `operator@${BASE_DOMAIN}`, access_level: "platform-user", wiki_role: "editor", authentik_groups: ["platform-operators", "platform-users"], argocd_role: "role:operator" },
      ],
      sha: "",
      raw: "",
    });
  }
});

export const POST = withAuth(
  {
    permission: "users:write",
    rateLimit: { name: "users-config-post", limit: 10, windowMs: 60_000 },
  },
  async ({ req, session }) => {
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
  },
);
