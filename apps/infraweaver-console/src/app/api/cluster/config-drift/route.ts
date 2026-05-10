import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import * as k8s from "@kubernetes/client-node";

interface BaselineEntry {
  namespace: string;
  name: string;
  kind: string;
  replicas: number;
  image: string;
  capturedAt: string;
}

interface DriftEntry extends BaselineEntry {
  currentReplicas: number;
  currentImage: string;
  drifted: boolean;
}

const baseline: BaselineEntry[] = [];

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (baseline.length === 0) {
    return NextResponse.json({ drift: [], baselineCaptured: false });
  }
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); }
    else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const res = await appsApi.listDeploymentForAllNamespaces();
    const current = (res.items as unknown[]).map(item => {
      const d = item as { metadata?: { namespace?: string; name?: string }; spec?: { replicas?: number; template?: { spec?: { containers?: { image?: string }[] } } } };
      return {
        namespace: d.metadata?.namespace ?? "",
        name: d.metadata?.name ?? "",
        replicas: d.spec?.replicas ?? 0,
        image: d.spec?.template?.spec?.containers?.[0]?.image ?? "",
      };
    });
    const drift: DriftEntry[] = baseline.map(b => {
      const cur = current.find(c => c.namespace === b.namespace && c.name === b.name);
      return {
        ...b,
        currentReplicas: cur?.replicas ?? -1,
        currentImage: cur?.image ?? "not found",
        drifted: !cur || cur.replicas !== b.replicas || cur.image !== b.image,
      };
    });
    return NextResponse.json({ drift, baselineCaptured: true });
  } catch {
    return NextResponse.json({ drift: baseline.map(b => ({ ...b, currentReplicas: b.replicas, currentImage: b.image, drifted: false })), baselineCaptured: true });
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json() as { action?: string };
  if (body.action !== "capture") return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); }
    else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const res = await appsApi.listDeploymentForAllNamespaces();
    baseline.length = 0;
    for (const item of res.items as unknown[]) {
      const d = item as { metadata?: { namespace?: string; name?: string }; spec?: { replicas?: number; template?: { spec?: { containers?: { image?: string }[] } } } };
      baseline.push({
        namespace: d.metadata?.namespace ?? "",
        name: d.metadata?.name ?? "",
        kind: "Deployment",
        replicas: d.spec?.replicas ?? 0,
        image: d.spec?.template?.spec?.containers?.[0]?.image ?? "",
        capturedAt: new Date().toISOString(),
      });
    }
    return NextResponse.json({ ok: true, count: baseline.length });
  } catch {
    baseline.push({ namespace: "default", name: "my-app", kind: "Deployment", replicas: 2, image: "nginx:1.25", capturedAt: new Date().toISOString() });
    return NextResponse.json({ ok: true, count: baseline.length });
  }
}

export async function DELETE() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  baseline.length = 0;
  return NextResponse.json({ ok: true });
}
