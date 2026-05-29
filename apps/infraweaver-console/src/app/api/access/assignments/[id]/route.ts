import { NextRequest } from "next/server";
import type { Permission } from "@/lib/rbac";
import { apiError, apiSuccess, requireRoutePermissions, routeErrorResponse } from "@/lib/route-utils";
import { deleteAssignment } from "@/lib/access-store";

const MANAGE: Permission[] = ["rbac:admin", "cluster:admin"];

export async function DELETE(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await requireRoutePermissions({ any: MANAGE });
  if (session instanceof Response) return session;
  try {
    const { id } = await ctx.params;
    const ok = await deleteAssignment(id);
    if (!ok) return apiError("Assignment not found", { status: 404 });
    return apiSuccess({ ok: true });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
