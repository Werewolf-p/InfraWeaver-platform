import { NextRequest } from "next/server";
import { isGroupAllowedPermission, type Permission } from "@/lib/rbac";
import { apiError, apiSuccess, requireRoutePermissions, routeErrorResponse } from "@/lib/route-utils";
import { createGroup, loadAccessState } from "@/lib/access-store";

/**
 * Reject any permission a custom group is not allowed to confer (see
 * GROUP_DENIED_PERMISSIONS). Returns the first disallowed permission, or null.
 */
function firstDisallowedPermission(permissions: Permission[]): Permission | null {
  return permissions.find((permission) => !isGroupAllowedPermission(permission)) ?? null;
}

const MANAGE: Permission[] = ["rbac:admin", "cluster:admin"];

export async function GET() {
  const session = await requireRoutePermissions({ any: ["users:read", ...MANAGE] });
  if (session instanceof Response) return session;
  try {
    const { groups } = await loadAccessState();
    return apiSuccess({ groups });
  } catch (error) {
    return routeErrorResponse(error);
  }
}

interface CreateGroupBody {
  name?: string;
  description?: string;
  permissions?: Permission[];
  members?: string[];
}

export async function POST(request: NextRequest) {
  const session = await requireRoutePermissions({ any: MANAGE });
  if (session instanceof Response) return session;
  try {
    const body = (await request.json().catch(() => ({}))) as CreateGroupBody;
    const name = body.name?.trim();
    if (!name) return apiError("Group name is required", { status: 400 });
    const permissions = Array.isArray(body.permissions) ? body.permissions : [];
    const disallowed = firstDisallowedPermission(permissions);
    if (disallowed) return apiError(`Permission ${disallowed} cannot be granted via custom groups`, { status: 400 });
    const actor = session.user?.email ?? "unknown";
    const group = await createGroup(
      {
        name,
        description: body.description,
        permissions,
        members: Array.isArray(body.members) ? body.members : [],
      },
      actor,
    );
    return apiSuccess({ group }, { status: 201 });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
