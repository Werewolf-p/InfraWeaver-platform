import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRole } from "@/lib/rbac";
import { auditLog } from "@/lib/audit-log";
import { loadKubeConfig } from "@/lib/k8s";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { z } from "zod";
import * as k8s from "@kubernetes/client-node";

function makeKc() {
  return loadKubeConfig();
}

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (getRole(groups) !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("cluster-scale", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const result = z.object({
    namespace: z.string().min(1).max(63),
    deployment: z.string().min(1).max(253),
    replicas: z.number().int().min(0).max(20),
  }).safeParse(await req.json());
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });

  const { namespace, deployment, replicas } = result.data;
  try {
    const appsApi = makeKc().makeApiClient(k8s.AppsV1Api);
    await appsApi.patchNamespacedDeployment({ name: deployment, namespace, body: { spec: { replicas } } });
    await auditLog("cluster:scale", session.user?.email ?? "unknown", `scaled ${namespace}/${deployment} to ${replicas}`);
    return NextResponse.json({ ok: true, replicas });
  } catch {
    return NextResponse.json({ ok: true, simulated: true, replicas });
  }
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const namespace = req.nextUrl.searchParams.get("namespace") ?? "";
  const deployment = req.nextUrl.searchParams.get("deployment") ?? "";
  if (!namespace || !deployment) return NextResponse.json({ error: "namespace and deployment required" }, { status: 400 });

  try {
    const appsApi = makeKc().makeApiClient(k8s.AppsV1Api);
    const dep = await appsApi.readNamespacedDeployment({ name: deployment, namespace });
    return NextResponse.json({ replicas: dep.spec?.replicas ?? 1 });
  } catch {
    return NextResponse.json({ replicas: 1, simulated: true });
  }
}
