import { NextResponse } from "next/server";
import { iwApiFetch } from "@/lib/iw-api";
import { withAuth } from "@/lib/with-auth";

export const GET = withAuth({ permission: "cluster:read" }, async ({ session }) => {
  const res = await iwApiFetch("/network/policies", session, "local");
  return NextResponse.json(await res.json(), { status: res.status });
});
