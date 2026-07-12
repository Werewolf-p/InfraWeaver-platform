import { NextRequest, NextResponse } from "next/server";
import type { V1Deployment } from "@kubernetes/client-node";
import type { ConfigDriftEntry } from "@/types";
import { z } from "zod";
import { makeAppsApi } from "@/lib/kube-client";
import { apiError, apiSuccess, requireRoutePermissions } from "@/lib/route-utils";

const captureBodySchema = z.object({
  action: z.literal("capture"),
});

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
    // Never report "no drift" when the live cluster could not be read — that
    // would be a fabricated clean bill of health.
    return apiError("Failed to read the live cluster for drift comparison", { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  const session = await requireRoutePermissions({ all: ["cluster:admin"] });
  if (session instanceof NextResponse) return session;

  const rawBody = await request.json().catch(() => null);
  const parsed = captureBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return apiError("Validation failed", { status: 400, details: parsed.error.flatten() });
  }

  try {
    const currentEntries = await listBaselineEntries();
    baseline.splice(0, baseline.length, ...currentEntries);
    return apiSuccess({ ok: true, count: baseline.length });
  } catch {
    // Do not fabricate a baseline when the cluster could not be read; keep the
    // previous baseline intact and surface the failure.
    return apiError("Failed to capture baseline from the live cluster", { status: 502 });
  }
}

export async function DELETE() {
  const session = await requireRoutePermissions({ all: ["cluster:admin"] });
  if (session instanceof NextResponse) return session;

  baseline.length = 0;
  return apiSuccess({ ok: true });
}
