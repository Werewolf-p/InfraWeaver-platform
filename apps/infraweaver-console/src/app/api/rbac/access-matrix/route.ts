import { NextResponse } from "next/server";
import { withRoute } from "@/lib/route-utils";
import { safeError } from "@/lib/utils";
import { collectMatrixPrincipals } from "@/lib/rbac-matrix-source";
import { buildAccessMatrix } from "@/lib/rbac-access-matrix";

// GET /api/rbac/access-matrix
// Azure-portal-style "who has access to what, where": every principal (users +
// groups) × their resolved grants, folding in users.yaml assignments, group
// assignments, legacy group roles, and active PIM/custom-group elevations.
export const GET = withRoute(["rbac:admin", "security:read"], async () => {
  try {
    const principals = await collectMatrixPrincipals();
    return NextResponse.json(buildAccessMatrix(principals));
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});
