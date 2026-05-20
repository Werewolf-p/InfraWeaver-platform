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
  if (searchParams.has("name")) params.set("name", searchParams.get("name")!);
  if (searchParams.has("limit")) params.set("limit", searchParams.get("limit")!);

  const res = await iwApiFetch(`/k8s/events?${params}`, session, getRequestClusterId(req));
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
