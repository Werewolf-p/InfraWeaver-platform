import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { auditLog } from "@/lib/audit-log";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { loadUsersConfig, saveUsersConfig } from "@/lib/users-config";
import { safeError } from "@/lib/utils";

const userPutSchema = z.record(z.string(), z.unknown());

// Authentik username: alphanumeric, dots, hyphens, underscores, @-sign
const SAFE_USERNAME_RE = /^[\w.@+-]{1,150}$/;


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
    const rawBody = await req.json().catch(() => ({}));
    const parsedBody = userPutSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return NextResponse.json({ error: "Validation failed", details: parsedBody.error.flatten() }, { status: 400 });
    }
    const body = parsedBody.data;
    const { users: rawUsers, sha } = await loadUsersConfig();

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

    const rest = { ...(body as { username?: string } & Record<string, unknown>) };
    delete rest.username;
    rawUsers[username] = { ...rawUsers[username], ...rest };

    await saveUsersConfig(rawUsers, sha, `chore: update user ${username} via InfraWeaver Console`);
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
    const { users: rawUsers, sha } = await loadUsersConfig();

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
    await saveUsersConfig(rawUsers, sha, `chore: delete user ${username} via InfraWeaver Console`);
    await auditLog("users-config:delete", currentUser.email ?? "unknown", `Deleted user ${username}`);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
