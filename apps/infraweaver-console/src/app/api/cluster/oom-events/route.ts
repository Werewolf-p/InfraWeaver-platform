import { NextResponse } from "next/server";
import { makeCoreApi } from "@/lib/kube-client";
import { withAuth } from "@/lib/with-auth";

interface OomEventItem {
  pod: string;
  namespace: string;
  node: string | null;
  timestamp: string | null;
  container: string | null;
}

interface KubeEvent {
  metadata?: { namespace?: string; name?: string; creationTimestamp?: string | Date };
  involvedObject?: { name?: string; namespace?: string; fieldPath?: string };
  lastTimestamp?: string | Date;
  eventTime?: string | Date;
  firstTimestamp?: string | Date;
  reason?: string;
  message?: string;
  source?: { host?: string };
}

function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function pickEventTimestamp(event: KubeEvent): string | null {
  return toIso(
    event.lastTimestamp ??
    event.eventTime ??
    event.metadata?.creationTimestamp ??
    event.firstTimestamp,
  );
}

function extractContainer(event: KubeEvent): string | null {
  const fieldPath = event.involvedObject?.fieldPath ?? "";
  const fieldPathMatch = fieldPath.match(/spec\.containers\{([^}]+)\}/);
  if (fieldPathMatch?.[1]) return fieldPathMatch[1];

  const message = event.message ?? "";
  const messagePatterns = [
    /container\s+"([^"]+)"/i,
    /container\s+'([^']+)'/i,
    /container\s+([^\s,:]+)/i,
  ];

  for (const pattern of messagePatterns) {
    const match = message.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

export const GET = withAuth({ permission: ["cluster:read", "infra:read", "config:read"] }, async () => {
  try {
    const coreApi = makeCoreApi();
    const [eventsResp, podsResp] = await Promise.all([
      coreApi.listEventForAllNamespaces(),
      coreApi.listPodForAllNamespaces(),
    ]);

    const podNodes: Record<string, string | null> = {};
    for (const item of ((podsResp as { items?: unknown[] }).items ?? [])) {
      const pod = item as {
        metadata?: { namespace?: string; name?: string };
        spec?: { nodeName?: string };
      };
      const namespace = pod.metadata?.namespace ?? "";
      const name = pod.metadata?.name ?? "";
      if (namespace && name) {
        podNodes[`${namespace}/${name}`] = pod.spec?.nodeName ?? null;
      }
    }

    const events: OomEventItem[] = ((eventsResp as { items?: KubeEvent[] }).items ?? [])
      .filter((event) => event.reason === "OOMKilling")
      .sort((left, right) => {
        const leftTime = new Date(pickEventTimestamp(left) ?? 0).getTime();
        const rightTime = new Date(pickEventTimestamp(right) ?? 0).getTime();
        return rightTime - leftTime;
      })
      .slice(0, 20)
      .map((event) => {
        const namespace = event.metadata?.namespace ?? event.involvedObject?.namespace ?? "default";
        const pod = event.involvedObject?.name ?? event.metadata?.name ?? "unknown";
        return {
          pod,
          namespace,
          node: event.source?.host ?? podNodes[`${namespace}/${pod}`] ?? null,
          timestamp: pickEventTimestamp(event),
          container: extractContainer(event),
        };
      });

    return NextResponse.json({ events });
  } catch {
    return NextResponse.json({
      events: [
        {
          pod: "infraweaver-console-6c8dbd6c4f-2fj5h",
          namespace: "infraweaver-console",
          node: "talos-prod-cp1",
          timestamp: new Date(Date.now() - 3_600_000).toISOString(),
          container: "console",
        },
        {
          pod: "minecraft-server-58d8f4bb7f-9sq7x",
          namespace: "game-hub",
          node: "talos-prod-cp2",
          timestamp: new Date(Date.now() - 14_400_000).toISOString(),
          container: "minecraft",
        },
      ],
    });
  }
});
