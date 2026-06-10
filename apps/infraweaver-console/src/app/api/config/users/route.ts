import { NextResponse } from "next/server";
import { withAuth } from "@/lib/with-auth";
import { loadUsersConfig } from "@/lib/users-config";
import { BASE_DOMAIN } from "@/lib/domain";

export const GET = withAuth({ permission: "users:read" }, async () => {
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
      { username: "admin", email: `admin@${BASE_DOMAIN}`, groups: ["platform-admins", "platform-users"] },
      { username: "operator", email: `operator@${BASE_DOMAIN}`, groups: ["platform-operators", "platform-users"] },
      { username: "viewer", email: `viewer@${BASE_DOMAIN}`, groups: ["platform-users"] },
    ]);
  }
});
