import { NextResponse } from "next/server";
import { loadCronJobs } from "@/lib/ops-data";
import { withAuth } from "@/lib/with-auth";

export const GET = withAuth({ permission: ["infra:read", "cluster:read"] }, async () => {
  return NextResponse.json(await loadCronJobs(), {
    headers: { "Cache-Control": "no-store" },
  });
});
