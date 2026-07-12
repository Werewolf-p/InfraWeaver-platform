import { NextResponse } from "next/server";
import { loadClusterEvents } from "@/lib/ops-data";
import { withAuth } from "@/lib/with-auth";

export const GET = withAuth({ permission: ["apps:read", "cluster:read", "infra:read"] }, async () => {
  return NextResponse.json(await loadClusterEvents(), {
    headers: { "Cache-Control": "no-store" },
  });
});
