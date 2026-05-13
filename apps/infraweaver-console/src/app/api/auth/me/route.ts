import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRole, hasPermission, type Permission } from "@/lib/rbac";

const ALL_PERMISSIONS: Permission[] = [
  "apps:read", "apps:sync", "apps:write", "config:read", "config:write",
  "catalog:write", "users:read", "users:write", "infra:read", "rbac:admin",
  "cluster:read", "game-hub:read", "game-hub:players", "game-hub:start", "game-hub:stop",
];

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
}
