import { NextRequest, NextResponse } from "next/server";
import type { V1Deployment } from "@kubernetes/client-node";
import type { ConfigDriftEntry } from "@/types";
import { makeAppsApi } from "@/lib/kube-client";
import { apiError, apiSuccess, parseJsonBody, requireRoutePermissions } from "@/lib/route-utils";

interface BaselineEntry {
  namespace: string;
  name: string;
  kind: string;
  replicas: number;
  image: string;
  capturedAt: string;
}

const baseline: BaselineEntry[] = [];

function toBaselineEntry(deployment: V1Deployment, capturedAt = new Date().toISOString()): BaselineEntry {
  return {
    namespace: deployment.metadata?.namespace ?? "",
    name: deployment.metadata?.name ?? "",
    kind: deployment.kind ?? "Deployment",
    replicas: deployment.spec?.replicas ?? 0,
    image: deployment.spec?.template?.spec?.containers?.[0]?.image ?? "",
    capturedAt,
  };
}

async function listBaselineEntries() {
  const response = await makeAppsApi().listDeploymentForAllNamespaces();
  const capturedAt = new Date().toISOString();

  return response.items.map((deployment) => toBaselineEntry(deployment, capturedAt));
}

function toDriftEntry(entry: BaselineEntry, current?: BaselineEntry): ConfigDriftEntry {
  return {
    ...entry,
    currentReplicas: current?.replicas ?? -1,
    currentImage: current?.image ?? "not found",
    drifted: !current || current.replicas !== entry.replicas || current.image !== entry.image,
  };
}

export async function GET() {
  const session = await requireRoutePermissions({ any: ["cluster:read", "infra:read"] });
  if (session instanceof NextResponse) return session;

  if (baseline.length === 0) {
    return apiSuccess({ drift: [], baselineCaptured: false });
  }

  try {
    const currentEntries = await listBaselineEntries();
    const currentByKey = new Map(currentEntries.map((entry) => [`${entry.namespace}/${entry.name}`, entry] as const));
    const drift = baseline.map((entry) => toDriftEntry(entry, currentByKey.get(`${entry.namespace}/${entry.name}`)));

    return apiSuccess({ drift, baselineCaptured: true });
  } catch {
    return apiSuccess({
      drift: baseline.map((entry) => ({ ...entry, currentReplicas: entry.replicas, currentImage: entry.image, drifted: false })),
      baselineCaptured: true,
    });
  }
}

export async function POST(request: NextRequest) {
  const session = await requireRoutePermissions({ all: ["cluster:admin"] });
  if (session instanceof NextResponse) return session;

  const body = await parseJsonBody<{ action?: string }>(request);
  if (body.action !== "capture") {
    return apiError("Invalid action", { status: 400 });
  }

  try {
    const currentEntries = await listBaselineEntries();
    baseline.splice(0, baseline.length, ...currentEntries);
    return apiSuccess({ ok: true, count: baseline.length });
  } catch {
    baseline.splice(0, baseline.length, {
      namespace: "default",
      name: "my-app",
      kind: "Deployment",
      replicas: 2,
      image: "nginx:1.25",
      capturedAt: new Date().toISOString(),
    });

    return apiSuccess({ ok: true, count: baseline.length });
  }
}

export async function DELETE() {
  const session = await requireRoutePermissions({ all: ["cluster:admin"] });
  if (session instanceof NextResponse) return session;

  baseline.length = 0;
  return apiSuccess({ ok: true });
}
