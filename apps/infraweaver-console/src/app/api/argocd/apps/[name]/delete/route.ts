import { NextRequest, NextResponse } from "next/server";

const ARGOCD_URL = process.env.ARGOCD_URL ?? "https://argocd.int.rlservers.com";
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? "";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  try {
    const res = await fetch(`${ARGOCD_URL}/api/v1/applications/${name}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${ARGOCD_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) throw new Error(`ArgoCD delete failed: ${res.status}`);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
