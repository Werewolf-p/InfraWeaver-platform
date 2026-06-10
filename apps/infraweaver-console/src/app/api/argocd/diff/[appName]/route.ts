import { NextResponse } from "next/server";
import { argocdFetch } from "@/lib/argocd-apps";
import { isValidK8sName } from "@/lib/validate";
import { withAuth } from "@/lib/with-auth";

export const GET = withAuth<{ appName: string }>(
  { permission: "apps:sync" },
  async ({ params }) => {
    const { appName } = params;
    if (!isValidK8sName(appName)) return NextResponse.json({ error: "Invalid app name" }, { status: 400 });
    try {
      const res = await argocdFetch(`/api/v1/applications/${appName}/manifests`);
      if (!res.ok) throw new Error(`ArgoCD error: ${res.status}`);
      const data = await res.json();
      return NextResponse.json(data);
    } catch {
      return NextResponse.json({ error: "ArgoCD unavailable" }, { status: 503 });
    }
  },
);
