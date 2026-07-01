import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";
import { findMatrixPrincipal } from "@/lib/rbac-matrix-source";
import { grantsToAssignments } from "@/lib/rbac-access-matrix";
import { explainPermission, isConcretePermission, scopeLabel, type Permission } from "@/lib/rbac";

const SAFE_SCOPE_RE = /^\/(|[a-z0-9/_-]+)$/;

// GET /api/rbac/explain?principal=alice&principalType=user&action=apps:read&scope=/apps
// Explains WHY a principal is (dis)allowed an action at a scope: allow/deny plus
// the deciding assignment(s). Deny wins over Allow (Azure semantics).
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["rbac:admin", "security:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const params = req.nextUrl.searchParams;
  const principalId = params.get("principal") ?? "";
  const principalType = params.get("principalType") === "group" ? "group" : "user";
  const action = params.get("action") ?? "";
  const scope = params.get("scope") ?? "/";

  if (!principalId) return NextResponse.json({ error: "principal is required" }, { status: 400 });
  if (!isConcretePermission(action)) return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  if (!SAFE_SCOPE_RE.test(scope)) return NextResponse.json({ error: "Invalid scope" }, { status: 400 });

  try {
    const principal = await findMatrixPrincipal(principalId, principalType);
    if (!principal) return NextResponse.json({ error: "Principal not found" }, { status: 404 });

    const assignments = grantsToAssignments(principal);
    const groups = principalType === "group" ? [principalId] : [];
    const username = principalType === "user" ? principalId : "";
    const explanation = explainPermission(groups, username, assignments, action as Permission, scope);

    return NextResponse.json({
      principal: principalId,
      principalType,
      action,
      scope,
      scopeLabel: scopeLabel(scope),
      ...explanation,
    });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
