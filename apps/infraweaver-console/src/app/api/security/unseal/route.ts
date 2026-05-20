import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";
import { z } from "zod";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "cluster:admin")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("security-unseal", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const result = z.object({ key: z.string().min(1).max(256) }).safeParse(await req.json());
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });

  try {
    const vaultAddr = process.env.VAULT_ADDR ?? "http://openbao.openbao.svc.cluster.local:8200";
    const res = await fetch(`${vaultAddr}/v1/sys/unseal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: result.data.key }),
    });
    if (!res.ok) throw new Error(`Vault error: ${res.status}`);
    const data = await res.json() as { sealed: boolean; progress: number; t: number };
    return NextResponse.json({ sealed: data.sealed, progress: data.progress, t: data.t });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
