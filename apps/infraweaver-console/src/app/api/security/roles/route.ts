import { NextResponse } from "next/server";
import { getBuiltInRoles } from "@/lib/rbac";
import { withRoute } from "@/lib/route-utils";

export const GET = withRoute("security:read", async () => NextResponse.json({ roles: getBuiltInRoles() }));
