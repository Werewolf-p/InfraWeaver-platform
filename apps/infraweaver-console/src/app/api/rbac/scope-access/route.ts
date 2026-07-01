import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";
import { collectMatrixPrincipals } from "@/lib/rbac-matrix-source";
import { buildScopeAccess } from "@/lib/rbac-access-matrix";
import { scopeLabel } from "@/lib/rbac";

const SAFE_SCOPE_RE = /^\/(|[a-z0-9/_-]+)$/;

// GET /api/rbac/scope-access?scope=/wordpress/sites/foo
// Scope-first "who has access here": every principal with a direct or inherited
// grant on the requested scope, with how (role + source scope + inherited flag).
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["rbac:admin", "security:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const scope = req.nextUrl.searchParams.get("scope") ?? "/";
  if (!SAFE_SCOPE_RE.test(scope)) return NextResponse.json({ error: "Invalid scope" }, { status: 400 });

  try {
    const principals = await collectMatrixPrincipals();
    return NextResponse.json({ scope, scopeLabel: scopeLabel(scope), entries: buildScopeAccess(principals, scope) });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
