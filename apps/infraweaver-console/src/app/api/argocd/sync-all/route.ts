import { NextResponse } from "next/server";

const ARGOCD_SERVER = process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local:80";
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? "";

export async function POST() {
  try {
    const listRes = await fetch(`${ARGOCD_SERVER}/api/v1/applications?limit=500`, {
      headers: {
        Authorization: `Bearer ${ARGOCD_TOKEN}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });
    if (!listRes.ok) throw new Error("Failed to list apps");
    const data = await listRes.json() as { items?: Array<{ metadata: { name: string }; status: { sync: { status: string } } }> };
    const apps = data.items ?? [];
    const outOfSync = apps.filter(a => a.status.sync.status === "OutOfSync");

    const synced: string[] = [];
    const errors: string[] = [];

    await Promise.all(
      outOfSync.map(async (app) => {
        try {
          const syncRes = await fetch(
            `${ARGOCD_SERVER}/api/v1/applications/${app.metadata.name}/sync`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${ARGOCD_TOKEN}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({}),
            }
          );
          if (!syncRes.ok) throw new Error(`Sync failed: ${syncRes.status}`);
          synced.push(app.metadata.name);
        } catch (e) {
          errors.push(`${app.metadata.name}: ${String(e)}`);
        }
      })
    );

    return NextResponse.json({ synced, errors, total: outOfSync.length });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
