import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import type { Permission } from "@/lib/rbac";
import { apiError, apiSuccess, routeErrorResponse } from "@/lib/route-utils";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { deactivateActivation } from "@/lib/access-store";

const MANAGE: Permission[] = ["rbac:admin", "cluster:admin"];

interface DeactivateBody {
  id?: string;
}

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) return apiError("Unauthorized", { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as DeactivateBody;
    const id = body.id?.trim();
    if (!id) return apiError("id is required", { status: 400 });

    const access = await getSessionRBACContext(session, 5);
    const isManager = hasAnySessionPermission(access, MANAGE);
    const email = session.user?.email ?? "";
    const actor = email || "unknown";

    const result = await deactivateActivation(id, actor, isManager ? undefined : email);
    if (!result.ok) return apiError(result.error ?? "Deactivation failed", { status: 403 });
    return apiSuccess({ activation: result.activation });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
