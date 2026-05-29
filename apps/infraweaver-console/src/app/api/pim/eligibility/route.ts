import { NextRequest } from "next/server";
import type { Session } from "next-auth";
import { auth } from "@/lib/auth";
import type { Permission } from "@/lib/rbac";
import { apiError, apiSuccess, requireRoutePermissions, routeErrorResponse } from "@/lib/route-utils";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { createEligibility, loadAccessState } from "@/lib/access-store";
import {
  PIM_ROLES,
  effectiveMaxDuration,
  eligibleRolesFor,
  isPimRoleId,
  type PrincipalType,
} from "@/lib/pim";

const MANAGE: Permission[] = ["rbac:admin", "cluster:admin"];

function identitiesFor(session: Session | null, username: string): string[] {
  const email = session?.user?.email ?? "";
  const explicit = (session?.user as { username?: string } | undefined)?.username ?? "";
  return [username, explicit, email].filter(Boolean);
}

export async function GET() {
  const session = await auth();
  if (!session) return apiError("Unauthorized", { status: 401 });
  try {
    const access = await getSessionRBACContext(session, 30);
    const state = await loadAccessState();
    const identities = identitiesFor(session, access.username);
    const eligible = eligibleRolesFor(state, identities, access.groups).map((entry) => ({
      ...entry,
      roleDefinition: PIM_ROLES[entry.role],
      maxDurationMinutes: effectiveMaxDuration(entry),
    }));
    const canManage = hasAnySessionPermission(access, MANAGE);

    return apiSuccess({
      roles: Object.values(PIM_ROLES),
      eligible,
      all: canManage ? state.eligibility : undefined,
      canManage,
    });
  } catch (error) {
    return routeErrorResponse(error);
  }
}

interface CreateEligibilityBody {
  principalType?: string;
  principalId?: string;
  role?: string;
  maxDurationMinutes?: number;
}

export async function POST(request: NextRequest) {
  const session = await requireRoutePermissions({ any: MANAGE });
  if (session instanceof Response) return session;
  try {
    const body = (await request.json().catch(() => ({}))) as CreateEligibilityBody;
    const principalType = body.principalType as PrincipalType;
    const principalId = body.principalId?.trim();
    if (principalType !== "user" && principalType !== "group") {
      return apiError("Invalid principal type", { status: 400 });
    }
    if (!principalId) return apiError("principalId is required", { status: 400 });
    if (!isPimRoleId(body.role)) return apiError("Invalid PIM role", { status: 400 });

    const actor = session.user?.email ?? "unknown";
    const eligibility = await createEligibility(
      {
        principalType,
        principalId,
        role: body.role,
        maxDurationMinutes:
          typeof body.maxDurationMinutes === "number" && body.maxDurationMinutes > 0
            ? Math.floor(body.maxDurationMinutes)
            : undefined,
      },
      actor,
    );
    return apiSuccess({ eligibility }, { status: 201 });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
