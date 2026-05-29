import { auth } from "@/lib/auth";
import type { Permission } from "@/lib/rbac";
import { apiError, apiSuccess, routeErrorResponse } from "@/lib/route-utils";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { loadAccessState } from "@/lib/access-store";
import { PIM_ROLES, activationStatus, normalizeIdentity, type PimActivation } from "@/lib/pim";

const MANAGE: Permission[] = ["rbac:admin", "cluster:admin"];

function decorate(activation: PimActivation, now: number) {
  return {
    ...activation,
    status: activationStatus(activation, now),
    roleName: PIM_ROLES[activation.role]?.name ?? activation.role,
  };
}

export async function GET() {
  const session = await auth();
  if (!session) return apiError("Unauthorized", { status: 401 });
  try {
    const access = await getSessionRBACContext(session, 5);
    const isManager = hasAnySessionPermission(access, MANAGE);
    const email = session.user?.email ?? "";
    const state = await loadAccessState();
    const now = Date.now();

    const visible = isManager
      ? state.activations
      : state.activations.filter((a) => normalizeIdentity(a.user) === normalizeIdentity(email));

    const decorated = visible.map((a) => decorate(a, now));
    const active = decorated.filter((a) => a.status === "active");
    const history = decorated.filter((a) => a.status !== "active");

    return apiSuccess({ active, history, canManageAll: isManager });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
