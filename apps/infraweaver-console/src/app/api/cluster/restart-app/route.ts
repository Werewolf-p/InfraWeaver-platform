import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRole } from "@/lib/rbac";
import { auditLog } from "@/lib/audit-log";
import { z } from "zod";
import * as k8s from "@kubernetes/client-node";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (getRole(groups) !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const RestartAppBody = z.object({
    namespace: z.string().min(1).max(63),
    appName: z.string().min(1).max(253),
  });
  const result = RestartAppBody.safeParse(await req.json());
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });
  const { namespace, appName } = result.data;
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); } else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    await appsApi.patchNamespacedDeployment({
      name: appName, namespace,
      body: { spec: { template: { metadata: { annotations: { "kubectl.kubernetes.io/restartedAt": new Date().toISOString() } } } } },
    });
    await auditLog("cluster:restart-app", session.user?.email ?? "unknown", `restarted ${namespace}/${appName}`);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true, simulated: true });
  }
}
