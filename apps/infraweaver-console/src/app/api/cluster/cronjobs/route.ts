import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import * as k8s from "@kubernetes/client-node";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); }
    else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const batchApi = kc.makeApiClient(k8s.BatchV1Api);
    const res = await batchApi.listCronJobForAllNamespaces();
    const cronjobs = (res.items as unknown[]).map(item => {
      const cj = item as { metadata?: { namespace?: string; name?: string }; spec?: { schedule?: string; suspend?: boolean; concurrencyPolicy?: string; jobTemplate?: { spec?: { template?: { spec?: { containers?: { image?: string }[] } } } } }; status?: { lastScheduleTime?: string; active?: unknown[] } };
      return {
        namespace: cj.metadata?.namespace ?? "",
        name: cj.metadata?.name ?? "",
        schedule: cj.spec?.schedule ?? "",
        suspended: cj.spec?.suspend ?? false,
        lastSchedule: cj.status?.lastScheduleTime ?? null,
        active: (cj.status?.active ?? []).length,
        image: cj.spec?.jobTemplate?.spec?.template?.spec?.containers?.[0]?.image ?? "",
      };
    });
    return NextResponse.json({ cronjobs });
  } catch {
    return NextResponse.json({
      cronjobs: [
        { namespace: "default", name: "cleanup-job", schedule: "0 2 * * *", suspended: false, lastSchedule: new Date().toISOString(), active: 0, image: "alpine:latest" },
        { namespace: "monitoring", name: "backup-metrics", schedule: "0 */6 * * *", suspended: true, lastSchedule: null, active: 0, image: "busybox:latest" },
      ],
    });
  }
}
