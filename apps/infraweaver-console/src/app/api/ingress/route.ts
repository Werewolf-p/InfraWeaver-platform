import { NextResponse } from "next/server";
import { loadIngressRoutes } from "@/lib/ops-data";
import { withAuth } from "@/lib/with-auth";

export const GET = withAuth({ permission: ["infra:read", "cluster:read", "security:read"] }, async () => {
  return NextResponse.json(await loadIngressRoutes(), {
    headers: { "Cache-Control": "no-store" },
  });
});
