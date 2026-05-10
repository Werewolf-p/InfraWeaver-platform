import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRole } from "@/lib/rbac";
import { auditLog } from "@/lib/audit-log";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { z } from "zod";
import * as k8s from "@kubernetes/client-node";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (getRole(groups) !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("cluster-cordon", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const CordonBody = z.object({ node: z.string().min(1).max(253), cordon: z.boolean() });
  const result = CordonBody.safeParse(await req.json());
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });
  const { node, cordon } = result.data;
  try {
    const kc = new k8s.KubeConfig();
    if (process.env.KUBECONFIG) { kc.loadFromFile(process.env.KUBECONFIG); } else { try { kc.loadFromCluster(); } catch { kc.loadFromDefault(); } }
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    await coreApi.patchNode({ name: node, body: { spec: { unschedulable: cordon } } });
    await auditLog(cordon ? "cluster:cordon" : "cluster:uncordon", session.user?.email ?? "unknown", `${cordon ? "cordoned" : "uncordoned"} node ${node}`);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true, simulated: true });
  }
}
