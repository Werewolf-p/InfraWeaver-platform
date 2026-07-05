import { NextRequest } from "next/server";
import { isGroupAllowedPermission, type Permission } from "@/lib/rbac";
import { apiError, apiSuccess, requireRoutePermissions, routeErrorResponse } from "@/lib/route-utils";
import { getSessionRBACContext, permissionsBeyondCeiling } from "@/lib/session-rbac";
import { createAssignment, loadAccessState } from "@/lib/access-store";
import type { PrincipalType, ResourceType } from "@/lib/pim";

const MANAGE: Permission[] = ["rbac:admin", "cluster:admin"];
const PRINCIPAL_TYPES: PrincipalType[] = ["user", "group"];
const RESOURCE_TYPES: ResourceType[] = ["app", "game-server", "hostname"];

export async function GET() {
  const session = await requireRoutePermissions({ any: ["users:read", ...MANAGE] });
  if (session instanceof Response) return session;
  try {
    const { assignments } = await loadAccessState();
    return apiSuccess({ assignments });
  } catch (error) {
    return routeErrorResponse(error);
  }
}

interface CreateAssignmentBody {
  principalType?: string;
  principalId?: string;
  resourceType?: string;
  resourceId?: string;
  permissions?: Permission[];
}

const HOSTNAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/i;

export async function POST(request: NextRequest) {
  const session = await requireRoutePermissions({ any: MANAGE });
  if (session instanceof Response) return session;
  try {
    const body = (await request.json().catch(() => ({}))) as CreateAssignmentBody;
    const principalType = body.principalType as PrincipalType;
    const resourceType = body.resourceType as ResourceType;
    const principalId = body.principalId?.trim();
    const resourceId = body.resourceId?.trim();

    if (!PRINCIPAL_TYPES.includes(principalType)) return apiError("Invalid principal type", { status: 400 });
    if (!RESOURCE_TYPES.includes(resourceType)) return apiError("Invalid resource type", { status: 400 });
    if (!principalId) return apiError("principalId is required", { status: 400 });
    if (!resourceId) return apiError("resourceId is required", { status: 400 });
    if (resourceType === "hostname" && !HOSTNAME_RE.test(resourceId)) {
      return apiError("Invalid hostname", { status: 400 });
    }

    const permissions = Array.isArray(body.permissions) ? body.permissions : [];
    // Same escalation-tier deny-list as custom groups, plus a privilege ceiling:
    // a resource assignment must never confer platform-escalation permissions or
    // anything the granter does not hold (SECURITY-AUDIT C1/C5).
    const disallowed = permissions.find((permission) => !isGroupAllowedPermission(permission));
    if (disallowed) return apiError(`Permission ${disallowed} cannot be granted via resource assignments`, { status: 400 });
    const context = await getSessionRBACContext(session);
    const beyond = permissionsBeyondCeiling(context, permissions);
    if (beyond.length > 0) {
      return apiError(`Cannot grant permissions you do not hold: ${beyond.join(", ")}`, { status: 403 });
    }

    const actor = session.user?.email ?? "unknown";
    const assignment = await createAssignment(
      {
        principalType,
        principalId,
        resourceType,
        resourceId,
        permissions,
      },
      actor,
    );
    return apiSuccess({ assignment }, { status: 201 });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
