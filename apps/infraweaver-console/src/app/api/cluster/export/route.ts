import { NextResponse } from "next/server";
import { iwApiFetch } from "@/lib/iw-api";
import { withAuth } from "@/lib/with-auth";

export const GET = withAuth({ permission: "cluster:read" }, async ({ session }) => {
  const res = await iwApiFetch("/cluster/export", session, "local");
  return new NextResponse(res.body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "application/x-yaml",
      "Content-Disposition": res.headers.get("Content-Disposition") ?? "attachment; filename=cluster-state.yaml",
    },
  });
});
