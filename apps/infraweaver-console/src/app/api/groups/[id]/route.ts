import { NextRequest } from "next/server";
import type { Permission } from "@/lib/rbac";
import { apiError, apiSuccess, requireRoutePermissions, routeErrorResponse } from "@/lib/route-utils";
import { deleteGroup, updateGroup } from "@/lib/access-store";

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
