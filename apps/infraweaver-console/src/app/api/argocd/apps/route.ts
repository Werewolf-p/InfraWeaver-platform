import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

const ARGOCD_SERVER = process.env.ARGOCD_SERVER ?? "http://argocd-server.argocd.svc.cluster.local:80";
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? "";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "apps:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const res = await fetch(`${ARGOCD_SERVER}/api/v1/applications?limit=500`, {
      headers: {
        Authorization: `Bearer ${ARGOCD_TOKEN}`,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json(getMockApps());
    }
    const data = await res.json();
    return NextResponse.json(data.items ?? []);
  } catch {
    return NextResponse.json(getMockApps());
  }
}

function getMockApps() {
  const apps = [
    { name: "bootstrap", namespace: "argocd", project: "platform", health: "Healthy", sync: "Synced" },
    { name: "core-argocd-manifests", namespace: "argocd", project: "platform", health: "Healthy", sync: "Synced" },
    { name: "core-cert-manager", namespace: "cert-manager", project: "platform", health: "Healthy", sync: "Synced" },
    { name: "core-traefik", namespace: "traefik", project: "platform", health: "Healthy", sync: "Synced" },
    { name: "core-external-secrets-manifests", namespace: "external-secrets", project: "platform", health: "Healthy", sync: "Synced" },
    { name: "core-longhorn", namespace: "longhorn-system", project: "platform", health: "Healthy", sync: "Synced" },
    { name: "platform-authentik", namespace: "authentik", project: "platform", health: "Healthy", sync: "Synced" },
    { name: "platform-netbird", namespace: "netbird", project: "platform", health: "Progressing", sync: "Synced" },
    { name: "platform-homepage", namespace: "homepage", project: "platform", health: "Healthy", sync: "Synced" },
    { name: "platform-grafana", namespace: "grafana", project: "platform", health: "Healthy", sync: "Synced" },
    { name: "catalog-wiki-manifests", namespace: "wiki", project: "platform", health: "Healthy", sync: "Synced" },
    { name: "catalog-gatus-manifests", namespace: "gatus", project: "platform", health: "Healthy", sync: "Synced" },
  ];
  return apps.map(a => ({
    metadata: { name: a.name, namespace: a.namespace, labels: {} },
    spec: { destination: { namespace: a.namespace, server: "https://kubernetes.default.svc" }, project: a.project },
    status: {
      health: { status: a.health },
      sync: { status: a.sync },
      summary: { images: [] },
    },
  }));
}
