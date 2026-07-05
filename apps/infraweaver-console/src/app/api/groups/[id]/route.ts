import { NextRequest } from "next/server";
import { isGroupAllowedPermission, type Permission } from "@/lib/rbac";
import { apiError, apiSuccess, requireRoutePermissions, routeErrorResponse } from "@/lib/route-utils";
import { getSessionRBACContext, permissionsBeyondCeiling } from "@/lib/session-rbac";
import { deleteGroup, getAccessState, updateGroup } from "@/lib/access-store";

/**
 * Reject any permission a custom group is not allowed to confer (see
 * GROUP_DENIED_PERMISSIONS). Returns the first disallowed permission, or null.
 */
function firstDisallowedPermission(permissions: Permission[]): Permission | null {
  return permissions.find((permission) => !isGroupAllowedPermission(permission)) ?? null;
}

const MANAGE: Permission[] = ["rbac:admin", "cluster:admin"];

interface PatchGroupBody {
  name?: string;
  description?: string;
  permissions?: Permission[];
  members?: string[];
}

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireRoutePermissions({ any: MANAGE });
  if (session instanceof Response) return session;
  try {
    const { id } = await ctx.params;
    const body = (await request.json().catch(() => ({}))) as PatchGroupBody;

    const replacingPermissions = Array.isArray(body.permissions);
    const changingMembers = Array.isArray(body.members);

    if (replacingPermissions) {
      const disallowed = firstDisallowedPermission(body.permissions!);
      if (disallowed) return apiError(`Permission ${disallowed} cannot be granted via custom groups`, { status: 400 });
    }

    // Privilege ceiling (SECURITY-AUDIT C1). Enforce it whenever the group's
    // conferred permissions could reach a principal the caller controls — i.e.
    // when permissions are being replaced OR when membership changes. Adding
    // yourself/anyone to a group whose existing permissions exceed your own
    // ceiling is an escalation just as much as raising the permissions directly,
    // so the check must run against the group's *effective* permission set, not
    // only the request body.
    if (replacingPermissions || changingMembers) {
      const existing = replacingPermissions
        ? undefined
        : (await getAccessState()).groups.find((g) => g.id === id);
      // If members change but the group no longer exists, let updateGroup 404 below.
      if (!(changingMembers && !replacingPermissions && !existing)) {
        const effectivePermissions = replacingPermissions ? body.permissions! : existing!.permissions;
        const context = await getSessionRBACContext(session);
        const beyond = permissionsBeyondCeiling(context, effectivePermissions);
        if (beyond.length > 0) {
          return apiError(`Cannot grant permissions you do not hold: ${beyond.join(", ")}`, { status: 403 });
        }
      }
    }
    const group = await updateGroup(id, {
      name: body.name,
      description: body.description,
      permissions: Array.isArray(body.permissions) ? body.permissions : undefined,
      members: Array.isArray(body.members) ? body.members : undefined,
    });
    if (!group) return apiError("Group not found", { status: 404 });
    return apiSuccess({ group });
  } catch (error) {
    return routeErrorResponse(error);
  }
}

export async function DELETE(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireRoutePermissions({ any: MANAGE });
  if (session instanceof Response) return session;
  try {
    const { id } = await ctx.params;
    const ok = await deleteGroup(id);
    if (!ok) return apiError("Group not found", { status: 404 });
    return apiSuccess({ ok: true });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
