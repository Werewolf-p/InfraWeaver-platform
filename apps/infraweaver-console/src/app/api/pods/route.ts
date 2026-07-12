import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { iwApiFetch } from "@/lib/iw-api";
import { withAuth } from "@/lib/with-auth";

export const GET = withAuth({ permission: "apps:read" }, async ({ req, session }) => {
  const { searchParams } = new URL(req.url);
  const params = new URLSearchParams();
  if (searchParams.has("namespace")) params.set("namespace", searchParams.get("namespace")!);
  if (searchParams.has("page")) params.set("page", searchParams.get("page")!);
  if (searchParams.has("limit")) params.set("limit", searchParams.get("limit")!);

  const res = await iwApiFetch(`/k8s/pods?${params}`, session, getRequestClusterId(req));
  const data = await res.json();
  // The backend returns { pods, clusterId, ... }, but every console consumer expects a bare
  // Pod[]. Unwrap on success to preserve that contract app-wide; pass errors through as-is.
  if (res.ok && data && typeof data === "object" && !Array.isArray(data) && Array.isArray((data as { pods?: unknown }).pods)) {
    return NextResponse.json((data as { pods: unknown[] }).pods, { status: res.status });
  }
  return NextResponse.json(data, { status: res.status });
});
