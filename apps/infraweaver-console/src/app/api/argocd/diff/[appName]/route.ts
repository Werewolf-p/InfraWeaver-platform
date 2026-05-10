import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRole } from "@/lib/rbac";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ appName: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  const role = getRole(groups);
  if (role !== "admin" && role !== "operator") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { appName } = await params;
  const server = process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local";
  const token = process.env.ARGOCD_TOKEN ?? "";
  try {
    const res = await fetch(`${server}/api/v1/applications/${appName}/manifests`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`ArgoCD error: ${res.status}`);
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ manifests: [], simulated: true });
  }
}
