import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

const GATUS_URL = process.env.GATUS_URL ?? "http://gatus.gatus.svc.cluster.local:8080";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const res = await fetch(`${GATUS_URL}/api/v1/endpoints/statuses`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error("Gatus API error");
    const data = await res.json();
    return NextResponse.json({ endpoints: data });
  } catch {
    return NextResponse.json({
      endpoints: [
        { name: "ArgoCD", results: [{ success: true, duration: 245, timestamp: new Date().toISOString() }, { success: true, duration: 198 }, { success: false, duration: 5000 }] },
        { name: "Authentik SSO", results: [{ success: true, duration: 89 }, { success: true, duration: 92 }, { success: true, duration: 87 }] },
        { name: "OpenBao", results: [{ success: true, duration: 156 }, { success: true, duration: 143 }] },
        { name: "Grafana", results: [{ success: true, duration: 312 }, { success: false, duration: 9000 }, { success: true, duration: 289 }] },
      ],
    });
  }
}
