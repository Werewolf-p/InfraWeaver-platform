import { NextResponse } from "next/server";
import { loadUsersConfig } from "@/lib/users-config";
import { withAuth } from "@/lib/with-auth";

export const GET = withAuth(
  { permission: "nas:read", rateLimit: { name: "nas-assignments", limit: 30, windowMs: 60_000 } },
  async () => {
    try {
      const { users: rawUsers } = await loadUsersConfig();
      const assignments = Object.entries(rawUsers).map(([username, data]) => ({
        username,
        name: (data.name as string) ?? username,
        nas_shares: (data.nas_shares as unknown[]) ?? [],
      }));
      return NextResponse.json({ assignments });
    } catch (e) {
      console.error("Failed to fetch assignments:", e);
      return NextResponse.json({ assignments: [] });
    }
  },
);
