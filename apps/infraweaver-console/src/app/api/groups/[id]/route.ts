import { NextRequest } from "next/server";
import { isGroupAllowedPermission, type Permission } from "@/lib/rbac";
import { apiError, apiSuccess, requireRoutePermissions, routeErrorResponse } from "@/lib/route-utils";
import { deleteGroup, updateGroup } from "@/lib/access-store";

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
    if (Array.isArray(body.permissions)) {
      const disallowed = firstDisallowedPermission(body.permissions);
      if (disallowed) return apiError(`Permission ${disallowed} cannot be granted via custom groups`, { status: 400 });
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
