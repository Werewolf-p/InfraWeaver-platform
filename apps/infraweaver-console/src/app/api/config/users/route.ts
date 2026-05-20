import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { loadUsersConfig } from "@/lib/users-config";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "users:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const { users } = await loadUsersConfig();
    return NextResponse.json(
      Object.entries(users).map(([username, user]) => ({
        username,
        ...user,
      })),
    );
  } catch {
    return NextResponse.json([
      { username: "admin", email: "admin@rlservers.com", groups: ["platform-admins", "platform-users"] },
      { username: "operator", email: "operator@rlservers.com", groups: ["platform-operators", "platform-users"] },
      { username: "viewer", email: "viewer@rlservers.com", groups: ["platform-users"] },
    ]);
  }
}
