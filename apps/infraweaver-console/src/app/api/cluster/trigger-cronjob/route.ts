import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { auditLog } from "@/lib/audit-log";
import { makeBatchApi } from "@/lib/kube-client";
import { z } from "zod";

const K8S_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const TriggerCronJobBody = z.object({
  namespace: z.string().min(1).max(63).regex(K8S_NAME_RE, "Invalid namespace name"),
  name: z.string().min(1).max(63).regex(K8S_NAME_RE, "Invalid cronjob name"),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "cluster:admin")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = TriggerCronJobBody.safeParse(await req.json());
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });

  const { namespace, name } = result.data;
  const jobName = `${name}-manual-${Date.now()}`;

  try {
    const batchApi = makeBatchApi();
    const cronJob = await batchApi.readNamespacedCronJob({ name, namespace });
    const jobSpec = cronJob.spec?.jobTemplate?.spec;
    if (!jobSpec) {
      return NextResponse.json({ error: "CronJob has no job template" }, { status: 400 });
    }

    await batchApi.createNamespacedJob({
      namespace,
      body: {
        metadata: {
          name: jobName,
          namespace,
          annotations: { "cronjob-name": name },
        },
        spec: jobSpec,
      },
    });

    await auditLog("cluster:trigger-cronjob", session.user?.email ?? "unknown", `triggered cronjob ${namespace}/${name} as ${jobName}`);
    return NextResponse.json({ ok: true, jobName });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "Operation failed" }, { status: 502 });
  }
}
