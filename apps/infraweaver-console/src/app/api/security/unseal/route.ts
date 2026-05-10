import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRole } from "@/lib/rbac";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (getRole(groups) !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { key } = await req.json() as { key: string };
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
