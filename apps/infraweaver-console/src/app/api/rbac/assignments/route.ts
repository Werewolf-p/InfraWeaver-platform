import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { getBuiltInRoles, type RoleAssignment } from "@/lib/rbac";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";
import { loadUsersConfig, normalizeRoleAssignments, saveUsersConfig } from "@/lib/users-config";
import { randomUUID } from "crypto";
import { z } from "zod";

const SAFE_SCOPE_RE = /^\/(|[a-z0-9/_-]+)$/;
const assignmentBodySchema = z.object({
  username: z.string().min(1).max(100),
  roleId: z.string().min(1).max(100),
  scope: z.string().min(1).max(200),
  principalType: z.enum(["user", "group"]).optional(),
  expiresAt: z.string().max(100).optional(),
}).strict();
const revokeAssignmentBodySchema = z.object({
  id: z.string().min(1).max(100),
  username: z.string().min(1).max(100),
}).strict();

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["users:read", "rbac:admin"])) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const file = await loadUsersConfig();
    const assignments: Array<RoleAssignment & { username: string; userEmail: string; userName: string }> = [];
    for (const [username, user] of Object.entries(file.users)) {
      for (const assignment of normalizeRoleAssignments(username, user.role_assignments)) {
        assignments.push({
          ...assignment,
          username,
          userEmail: user.email ?? "",
          userName: user.name ?? username,
        });
      }
    }
    return NextResponse.json({ assignments });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["users:write", "rbac:admin"])) return NextResponse.json({ error: "Forbidden: admin required" }, { status: 403 });

  const result = assignmentBodySchema.safeParse(await req.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.flatten() }, { status: 400 });
  }

  const body = result.data;
  if (!SAFE_SCOPE_RE.test(body.scope)) return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
  if (!getBuiltInRoles().some((role) => role.id === body.roleId)) return NextResponse.json({ error: "Unknown role" }, { status: 400 });

  try {
    const file = await loadUsersConfig();
    if (!file.users[body.username]) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const existing = normalizeRoleAssignments(body.username, file.users[body.username].role_assignments);
    if (existing.some((assignment) => assignment.roleId === body.roleId && assignment.scope === body.scope)) {
      return NextResponse.json({ error: "Assignment already exists" }, { status: 409 });
    }

    const newAssignment: RoleAssignment = {
      id: randomUUID(),
      roleId: body.roleId,
      scope: body.scope,
      principalType: body.principalType ?? "user",
      principalId: body.username,
      grantedBy: session.user?.email ?? "unknown",
      grantedAt: new Date().toISOString(),
      expiresAt: body.expiresAt,
    };
    file.users[body.username].role_assignments = [...existing, newAssignment];
    await saveUsersConfig(file.users, file.sha, `rbac: grant ${body.roleId} to ${body.username} at ${body.scope}`);
    await auditLog("rbac:assign", session.user?.email ?? "unknown", `Granted role '${body.roleId}' to '${body.username}' at scope '${body.scope}'`);
    return NextResponse.json({ ok: true, assignment: { ...newAssignment, username: body.username } });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["users:write", "rbac:admin"])) return NextResponse.json({ error: "Forbidden: admin required" }, { status: 403 });

  const result = revokeAssignmentBodySchema.safeParse(await req.json().catch(() => null));
  if (!result.success) {
    return NextResponse.json({ error: "Validation failed", details: result.error.flatten() }, { status: 400 });
  }

  const { id, username } = result.data;

  try {
    const file = await loadUsersConfig();
    if (!file.users[username]) return NextResponse.json({ error: "User not found" }, { status: 404 });
    const before = normalizeRoleAssignments(username, file.users[username].role_assignments);
    const after = before.filter((assignment) => assignment.id !== id);
    if (before.length === after.length) return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
    file.users[username].role_assignments = after;
    await saveUsersConfig(file.users, file.sha, `rbac: revoke assignment ${id} from ${username}`);
    await auditLog("rbac:revoke", session.user?.email ?? "unknown", `Revoked assignment '${id}' from '${username}'`);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
