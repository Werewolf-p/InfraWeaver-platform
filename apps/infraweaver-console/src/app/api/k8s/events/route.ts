import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import * as k8s from "@kubernetes/client-node";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const namespace = searchParams.get("namespace") ?? "default";
  const name = searchParams.get("name");

  try {
    const kc = new k8s.KubeConfig();
    try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); }
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);

    const fieldSelector = name
      ? `involvedObject.name=${name}`
      : undefined;

    const res = await coreApi.listNamespacedEvent({
      namespace,
      fieldSelector,
    });

    const events = (res.items ?? [])
      .sort((a, b) => {
        const ta = new Date(a.lastTimestamp ?? a.eventTime ?? 0).getTime();
        const tb = new Date(b.lastTimestamp ?? b.eventTime ?? 0).getTime();
        return tb - ta;
      })
      .slice(0, 50)
      .map((e) => ({
        name: e.metadata?.name,
        reason: e.reason,
        message: e.message,
        type: e.type,
        count: e.count ?? 1,
        lastTimestamp: e.lastTimestamp ?? e.eventTime,
        involvedObject: {
          kind: e.involvedObject?.kind,
          name: e.involvedObject?.name,
        },
      }));

    return NextResponse.json({ events });
  } catch (err) {
    console.error("k8s events error:", err);
    return NextResponse.json({ events: [] });
  }
}
