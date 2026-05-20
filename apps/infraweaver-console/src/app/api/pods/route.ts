import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRequestClusterId } from "@/lib/cluster-context";
import { iwApiFetch } from "@/lib/iw-api";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const params = new URLSearchParams();
  if (searchParams.has("namespace")) params.set("namespace", searchParams.get("namespace")!);
  if (searchParams.has("page")) params.set("page", searchParams.get("page")!);
  if (searchParams.has("limit")) params.set("limit", searchParams.get("limit")!);

  const res = await iwApiFetch(`/k8s/pods?${params}`, session, getRequestClusterId(req));
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
