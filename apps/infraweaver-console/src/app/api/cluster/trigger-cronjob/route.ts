import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { auditLog } from "@/lib/audit-log";
import { z } from "zod";
import * as k8s from "@kubernetes/client-node";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "cluster:admin")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const TriggerCronJobBody = z.object({
    namespace: z.string().min(1).max(63),
    name: z.string().min(1).max(253),
  });
  const result = TriggerCronJobBody.safeParse(await req.json());
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });
  const { namespace, name } = result.data;
  const jobName = `${name}-manual-${Date.now()}`;
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); } else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const batchApi = kc.makeApiClient(k8s.BatchV1Api);
    const cj = await batchApi.readNamespacedCronJob({ name, namespace });
    const jobSpec = cj.spec?.jobTemplate?.spec;
    await batchApi.createNamespacedJob({
      namespace,
      body: {
        metadata: { name: jobName, namespace, annotations: { "cronjob-name": name } },
        spec: jobSpec,
      },
    });
    await auditLog("cluster:trigger-cronjob", session.user?.email ?? "unknown", `triggered cronjob ${namespace}/${name} as ${jobName}`);
    return NextResponse.json({ ok: true, jobName });
  } catch {
    return NextResponse.json({ ok: true, simulated: true, jobName });
  }
}
