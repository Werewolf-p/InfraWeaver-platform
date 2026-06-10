import { NextResponse, NextRequest } from "next/server";
import { getRole, hasPermission, type Permission } from "@/lib/rbac";
import { withRoute } from "@/lib/route-utils";

const ALL_PERMISSIONS: Permission[] = [
  "apps:read", "apps:sync", "apps:write", "config:read", "config:write",
  "catalog:write", "users:read", "users:write", "infra:read", "rbac:admin",
  "cluster:read", "game-hub:read", "game-hub:players", "game-hub:start", "game-hub:stop",
];

export const GET = withRoute(null, async (_req: NextRequest, session) => {
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  const role = getRole(groups);
  const permissions = role === "admin"
    ? ["*"]
    : ALL_PERMISSIONS.filter((p) => hasPermission(groups, p));
  return NextResponse.json({
    email: session.user?.email,
    name: session.user?.name,
    groups,
    role,
    permissions,
  });
});
