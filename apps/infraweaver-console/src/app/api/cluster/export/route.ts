import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { iwApiFetch } from "@/lib/iw-api";

export async function GET() {
  const session = await auth();
  if (!session) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  const res = await iwApiFetch("/cluster/export", session, "local");
  return new Response(res.body, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "application/x-yaml",
      "Content-Disposition": res.headers.get("Content-Disposition") ?? "attachment; filename=cluster-state.yaml",
    },
  });
}
