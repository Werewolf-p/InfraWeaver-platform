import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { apiError, apiSuccess, routeErrorResponse } from "@/lib/route-utils";
import { getSessionRBACContext } from "@/lib/session-rbac";
import { activateRole } from "@/lib/access-store";
import { PIM_DURATION_OPTIONS } from "@/lib/pim";

interface ActivateBody {
  role?: string;
  durationMinutes?: number;
  reason?: string;
}

const MAX_DURATION = Math.max(...PIM_DURATION_OPTIONS, 480);

export async function POST(request: NextRequest) {
  const session = await auth();
  if (!session) return apiError("Unauthorized", { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as ActivateBody;
    const role = body.role;
    if (!role) return apiError("role is required", { status: 400 });
    const reason = (body.reason ?? "").trim();
    if (reason.length < 3) return apiError("A justification reason is required", { status: 400 });
    const durationMinutes = Number(body.durationMinutes);
    if (!Number.isFinite(durationMinutes) || durationMinutes < 1 || durationMinutes > MAX_DURATION) {
      return apiError("Invalid duration", { status: 400 });
    }

    const access = await getSessionRBACContext(session, 5);
    const email = session.user?.email ?? "";
    if (!email) return apiError("Cannot determine user identity", { status: 400 });
    const explicit = (session.user as { username?: string } | undefined)?.username ?? "";
    const identities = [access.username, explicit, email].filter(Boolean);

    const result = await activateRole({
      user: email,
      identities,
      authentikGroups: access.groups,
      role,
      durationMinutes,
      reason,
    });

    if (!result.ok) return apiError(result.error ?? "Activation failed", { status: 403 });
    return apiSuccess({ activation: result.activation }, { status: 201 });
  } catch (error) {
    return routeErrorResponse(error);
  }
}
