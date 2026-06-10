import { NextResponse } from "next/server";
import { withAuth } from "@/lib/with-auth";
import { auditLog } from "@/lib/audit-log";
import { assignmentExceedsGranter, getBuiltInRoles, type RoleAssignment } from "@/lib/rbac";
import { getSessionEffectivePermissions, getSessionRBACContext } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";
import { loadUsersConfig, normalizeRoleAssignments, saveUsersConfig } from "@/lib/users-config";
import { randomUUID } from "crypto";
import { z } from "zod";

const SAFE_USERNAME_RE = /^[\w.@+-]{1,150}$/;
const SAFE_SCOPE_RE = /^\/(|[a-z0-9/_-]+)$/;

const CreateAssignmentBody = z.object({
  roleId: z.string().min(1),
  scope: z.string().min(1),
  principalType: z.enum(["user", "group"]).default("user"),
  expiresAt: z.string().datetime().optional(),
});

export const GET = withAuth<{ username: string }>(
  { permission: "users:read" },
  async ({ params }) => {
    const { username } = params;
    if (!SAFE_USERNAME_RE.test(username)) return NextResponse.json({ error: "Invalid username" }, { status: 400 });

    try {
      const file = await loadUsersConfig();
      const user = file.users[username];
      if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
      return NextResponse.json({ role_assignments: normalizeRoleAssignments(username, user.role_assignments) });
    } catch (error) {
      return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
  },
);

export const POST = withAuth<{ username: string }>(
  { permission: "users:write" },
  async ({ req, session, params }) => {
    const { username } = params;
    if (!SAFE_USERNAME_RE.test(username)) return NextResponse.json({ error: "Invalid username" }, { status: 400 });

    const result = CreateAssignmentBody.safeParse(await req.json());
    if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });
    if (!SAFE_SCOPE_RE.test(result.data.scope)) return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
    if (!getBuiltInRoles().some((role) => role.id === result.data.roleId)) {
      return NextResponse.json({ error: "Unknown role" }, { status: 400 });
    }

    // Privilege ceiling: a granter cannot assign a role conferring permissions
    // they do not themselves hold (no admin -> owner escalation). The users:write
    // mint gate controls *who* reaches this route; this narrows *what* they grant.
    const access = await getSessionRBACContext(session);
    const granterPerms = getSessionEffectivePermissions(access, "/");
    if (assignmentExceedsGranter(granterPerms, result.data.roleId)) {
      await auditLog("rbac:assign:denied", session.user?.email ?? "unknown", `Denied granting ${result.data.roleId} to ${username}: exceeds granter permissions`);
      return NextResponse.json({ error: "Cannot grant a role that exceeds your own permissions" }, { status: 403 });
    }

    try {
      const file = await loadUsersConfig();
      const user = file.users[username];
      if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

      const assignments = normalizeRoleAssignments(username, user.role_assignments);
      if (assignments.some((assignment) => assignment.roleId === result.data.roleId && assignment.scope === result.data.scope)) {
        return NextResponse.json({ error: "Assignment already exists" }, { status: 409 });
      }

      const assignment: RoleAssignment = {
        id: randomUUID(),
        roleId: result.data.roleId,
        scope: result.data.scope,
        principalType: result.data.principalType,
        principalId: username,
        grantedBy: session.user?.email ?? "unknown",
        grantedAt: new Date().toISOString(),
        expiresAt: result.data.expiresAt,
      };
      user.role_assignments = [...assignments, assignment];
      await saveUsersConfig(file.users, file.sha, `rbac: grant ${assignment.roleId} to ${username} at ${assignment.scope}`);
      await auditLog("rbac:assign", session.user?.email ?? "unknown", `Granted ${assignment.roleId} to ${username} at ${assignment.scope}`);
      return NextResponse.json({ ok: true, assignment });
    } catch (error) {
      return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
  },
);

export const DELETE = withAuth<{ username: string }>(
  { permission: "users:write" },
  async ({ req, session, params }) => {
    const { username } = params;
    if (!SAFE_USERNAME_RE.test(username)) return NextResponse.json({ error: "Invalid username" }, { status: 400 });
    const body = await req.json() as { assignmentId?: string; id?: string };
    const assignmentId = body.assignmentId ?? body.id;
    if (!assignmentId) return NextResponse.json({ error: "assignmentId required" }, { status: 400 });

    try {
      const file = await loadUsersConfig();
      const user = file.users[username];
      if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

      const assignments = normalizeRoleAssignments(username, user.role_assignments);
      const nextAssignments = assignments.filter((assignment) => assignment.id !== assignmentId);
      if (assignments.length === nextAssignments.length) {
        return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
      }

      user.role_assignments = nextAssignments;
      await saveUsersConfig(file.users, file.sha, `rbac: revoke assignment ${assignmentId} from ${username}`);
      await auditLog("rbac:revoke", session.user?.email ?? "unknown", `Revoked assignment ${assignmentId} from ${username}`);
      return NextResponse.json({ ok: true });
    } catch (error) {
      return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
  },
);
