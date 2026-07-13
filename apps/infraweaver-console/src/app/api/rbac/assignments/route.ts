import { NextRequest, NextResponse } from "next/server";
import { type RoleAssignment } from "@/lib/rbac";
import { getSessionEffectivePermissions, hasAnySessionPermission } from "@/lib/session-rbac";
import { grantRoleAssignment, revokeRoleAssignment } from "@/lib/rbac-assignments";
import { parseBody, withRoute } from "@/lib/route-utils";
import { sessionActor } from "@/lib/user-guards";
import { safeError } from "@/lib/utils";
import { loadUsersConfig, normalizeGroupRoleAssignments, normalizeRoleAssignments } from "@/lib/users-config";
import { z } from "zod";

const SAFE_SCOPE_RE = /^\/(|[a-z0-9/_-]+)$/;
const SAFE_GROUP_RE = /^[\w .@+/-]{1,100}$/;
const assignmentBodySchema = z.object({
  username: z.string().min(1).max(100).optional(),
  group: z.string().min(1).max(100).optional(),
  roleId: z.string().min(1).max(100),
  scope: z.string().min(1).max(200),
  principalType: z.enum(["user", "group"]).optional(),
  expiresAt: z.string().max(100).optional(),
  effect: z.enum(["Allow", "Deny"]).optional(),
}).strict();
const revokeAssignmentBodySchema = z.object({
  id: z.string().min(1).max(100),
  username: z.string().min(1).max(100).optional(),
  group: z.string().min(1).max(100).optional(),
  principalType: z.enum(["user", "group"]).optional(),
}).strict();

/** An assignment enriched with the display fields the RBAC settings table expects. */
type AssignmentRow = RoleAssignment & { username: string; userEmail: string; userName: string };

export const GET = withRoute(["users:read", "rbac:admin"], async () => {
  try {
    const file = await loadUsersConfig();
    const assignments: AssignmentRow[] = [];
    for (const [username, user] of Object.entries(file.users)) {
      for (const assignment of normalizeRoleAssignments(username, user.role_assignments)) {
        assignments.push({ ...assignment, username, userEmail: user.email ?? "", userName: user.name ?? username });
      }
    }
    // Group-principal assignments live under the top-level groups: section.
    for (const [groupName, group] of Object.entries(file.groups)) {
      for (const assignment of normalizeGroupRoleAssignments(groupName, group.role_assignments)) {
        assignments.push({ ...assignment, username: groupName, userEmail: "", userName: groupName });
      }
    }
    return NextResponse.json({ assignments });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});

export const POST = withRoute(null, async (req: NextRequest, session, access) => {
  if (!hasAnySessionPermission(access, ["users:write", "rbac:admin"])) {
    return NextResponse.json({ error: "Forbidden: admin required" }, { status: 403 });
  }

  const body = await parseBody(req, assignmentBodySchema);
  if (body instanceof NextResponse) return body;
  if (!SAFE_SCOPE_RE.test(body.scope)) return NextResponse.json({ error: "Invalid scope" }, { status: 400 });

  const principalType = body.principalType ?? (body.group ? "group" : "user");
  const rawPrincipal = principalType === "group" ? (body.group ?? body.username) : body.username;
  if (!rawPrincipal) return NextResponse.json({ error: "Missing principal (username or group)" }, { status: 400 });
  // Trim group names before validation/persist: SAFE_GROUP_RE allows internal
  // spaces, so a padded " platform-admins" would otherwise pass and be stored as
  // a distinct users.yaml key no (trimmed) session group can match.
  const principal = principalType === "group" ? rawPrincipal.trim() : rawPrincipal;
  if (principalType === "group" && !SAFE_GROUP_RE.test(principal)) return NextResponse.json({ error: "Invalid group name" }, { status: 400 });

  const granterPermsAt = (scope: string) => getSessionEffectivePermissions(access, scope);
  try {
    const outcome = await grantRoleAssignment(
      { roleId: body.roleId, scope: body.scope, principalType, principal, expiresAt: body.expiresAt, effect: body.effect },
      { granterPermsAt, actor: sessionActor(session) },
    );
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    return NextResponse.json({ ok: true, assignment: { ...outcome.assignment, username: principal } });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});

export const DELETE = withRoute(null, async (req: NextRequest, session, access) => {
  if (!hasAnySessionPermission(access, ["users:write", "rbac:admin"])) {
    return NextResponse.json({ error: "Forbidden: admin required" }, { status: 403 });
  }

  const body = await parseBody(req, revokeAssignmentBodySchema);
  if (body instanceof NextResponse) return body;

  const { id, username, group } = body;
  const principalType = body.principalType ?? (group ? "group" : "user");
  const principal = principalType === "group" ? (group ?? username) : username;
  if (!principal) return NextResponse.json({ error: "Missing principal (username or group)" }, { status: 400 });

  const granterPermsAt = (scope: string) => getSessionEffectivePermissions(access, scope);
  try {
    const outcome = await revokeRoleAssignment(
      { assignmentId: id, principalType, principal },
      { granterPermsAt, actor: sessionActor(session) },
    );
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});
