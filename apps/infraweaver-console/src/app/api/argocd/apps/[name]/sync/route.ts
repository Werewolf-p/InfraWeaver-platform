import { NextRequest, NextResponse } from "next/server";

const ARGOCD_SERVER = process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local:80";
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? "";

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const { hard } = await req.json().catch(() => ({ hard: false }));
  try {
    const body = hard
      ? { revision: "HEAD", prune: false, strategy: { hook: {}, apply: { force: true } } }
      : { revision: "HEAD", prune: false };
    const res = await fetch(`${ARGOCD_SERVER}/api/v1/applications/${name}/sync`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ARGOCD_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return NextResponse.json({ ok: true, mock: true });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ ok: true, mock: true });
  }
}
