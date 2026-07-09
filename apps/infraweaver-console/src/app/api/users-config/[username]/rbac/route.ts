import { NextResponse } from "next/server";
import { withAuth } from "@/lib/with-auth";
import { getSessionEffectivePermissions, getSessionRBACContext } from "@/lib/session-rbac";
import { grantRoleAssignment, revokeRoleAssignment } from "@/lib/rbac-assignments";
import { safeError } from "@/lib/utils";
import { loadUsersConfig, normalizeRoleAssignments } from "@/lib/users-config";
import { z } from "zod";

const SAFE_USERNAME_RE = /^[\w.@+-]{1,150}$/;
const SAFE_SCOPE_RE = /^\/(|[a-z0-9/_-]+)$/;
const SAFE_GROUP_RE = /^[\w .@+/-]{1,100}$/;

const CreateAssignmentBody = z.object({
  roleId: z.string().min(1),
  scope: z.string().min(1),
  principalType: z.enum(["user", "group"]).default("user"),
  group: z.string().min(1).max(100).optional(),
  expiresAt: z.string().datetime().optional(),
  effect: z.enum(["Allow", "Deny"]).optional(),
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

    const principalType = result.data.principalType;
    const principal = principalType === "group" ? (result.data.group ?? "") : username;
    if (principalType === "group" && !SAFE_GROUP_RE.test(principal)) return NextResponse.json({ error: "Invalid group name" }, { status: 400 });

    const access = await getSessionRBACContext(session);
    const granterPerms = getSessionEffectivePermissions(access, "/");
    try {
      const outcome = await grantRoleAssignment(
        { roleId: result.data.roleId, scope: result.data.scope, principalType, principal, expiresAt: result.data.expiresAt, effect: result.data.effect },
        { granterPerms, actor: session.user?.email ?? "unknown" },
      );
      if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
      return NextResponse.json({ ok: true, assignment: outcome.assignment });
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
    const body = await req.json() as { assignmentId?: string; id?: string; principalType?: "user" | "group"; group?: string };
    const assignmentId = body.assignmentId ?? body.id;
    if (!assignmentId) return NextResponse.json({ error: "assignmentId required" }, { status: 400 });

    const principalType = body.principalType ?? "user";
    const principal = principalType === "group" ? (body.group ?? "") : username;
    if (principalType === "group" && !principal) return NextResponse.json({ error: "Missing group name" }, { status: 400 });

    const access = await getSessionRBACContext(session);
    const granterPerms = getSessionEffectivePermissions(access, "/");
    try {
      const outcome = await revokeRoleAssignment(
        { assignmentId, principalType, principal },
        { granterPerms, actor: session.user?.email ?? "unknown" },
      );
      if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
      return NextResponse.json({ ok: true });
    } catch (error) {
      return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
  },
);
