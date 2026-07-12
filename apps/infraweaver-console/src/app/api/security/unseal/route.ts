import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { withRoute } from "@/lib/route-utils";
import { safeError } from "@/lib/utils";
import { z } from "zod";

export const POST = withRoute("cluster:admin", async (req) => {
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
});
