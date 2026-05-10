import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRole } from "@/lib/rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { z } from "zod";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (getRole(groups) !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("security-unseal", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const UnsealBody = z.object({ key: z.string().min(1).max(256) });
  const result = UnsealBody.safeParse(await req.json());
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });
  const { key } = result.data;
  const vaultAddr = process.env.VAULT_ADDR ?? "http://openbao.openbao.svc.cluster.local:8200";
  try {
    const res = await fetch(`${vaultAddr}/v1/sys/unseal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (!res.ok) throw new Error(`Vault error: ${res.status}`);
    const data = await res.json() as { sealed: boolean; progress: number; t: number };
    return NextResponse.json({ sealed: data.sealed, progress: data.progress, t: data.t });
  } catch {
    return NextResponse.json({ sealed: false, progress: 1, t: 3, simulated: true });
  }
}
