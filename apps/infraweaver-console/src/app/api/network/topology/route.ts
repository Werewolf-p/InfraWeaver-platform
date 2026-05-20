import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { iwApiFetch } from "@/lib/iw-api";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const res = await iwApiFetch("/network/topology", session, "local");
  return NextResponse.json(await res.json(), { status: res.status });
}
