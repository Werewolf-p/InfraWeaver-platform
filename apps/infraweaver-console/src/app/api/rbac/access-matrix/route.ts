import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasAnySessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";
import { collectMatrixPrincipals } from "@/lib/rbac-matrix-source";
import { buildAccessMatrix } from "@/lib/rbac-access-matrix";

// GET /api/rbac/access-matrix
// Azure-portal-style "who has access to what, where": every principal (users +
// groups) × their resolved grants, folding in users.yaml assignments, group
// assignments, legacy group roles, and active PIM/custom-group elevations.
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasAnySessionPermission(access, ["rbac:admin", "security:read"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const principals = await collectMatrixPrincipals();
    return NextResponse.json(buildAccessMatrix(principals));
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
