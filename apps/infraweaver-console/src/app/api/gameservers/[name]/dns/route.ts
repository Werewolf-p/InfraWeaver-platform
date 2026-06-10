import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getARecord, createARecord, deleteARecord } from "@/lib/cloudflare";
import { validateK8sName } from "@/lib/api-security";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";
import { internalHost, publicHost } from "@/lib/domain";

const dnsPatchSchema = z.object({
  targetIP: z.string().min(1),
  internalIP: z.string().optional(),
  publicDns: z.boolean(),
  internalDns: z.boolean(),
});

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "game-hub:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { name } = await params;
  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });

  // Get target IPs from ConfigMap
  let targetIP = "";
  let internalIP = "";
  try {
    const k8s = await import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const cm = await coreApi.readNamespacedConfigMap({ name, namespace: "game-servers" });
    targetIP = cm.data?.["target-ip"] ?? "";
    internalIP = cm.data?.["internal-ip"] ?? "";
  } catch {}

  const [publicRecord, internalRecord] = await Promise.all([
    getARecord(publicHost(name)).catch(() => null),
    getARecord(internalHost(name)).catch(() => null),
  ]);

  return NextResponse.json({
    targetIP,
    internalIP: internalIP || targetIP,
    public: publicRecord ? { exists: true, ip: publicRecord.content, id: publicRecord.id } : { exists: false },
    internal: internalRecord ? { exists: true, ip: internalRecord.content, id: internalRecord.id } : { exists: false },
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "game-hub:write")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { name } = await params;
  const nameErr2 = validateK8sName(name);
  if (nameErr2) return NextResponse.json(nameErr2.error, { status: nameErr2.status });
  const rawBody = await req.json().catch(() => ({}));
  const parsedBody = dnsPatchSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json({ error: "Validation failed", details: parsedBody.error.flatten() }, { status: 400 });
  }
  const { targetIP, internalIP, publicDns, internalDns } = parsedBody.data;

  const results: Record<string, unknown> = {};
  const intIP = internalIP || targetIP;

  if (publicDns) {
    await deleteARecord(publicHost(name)).catch(() => {});
    try { results.public = await createARecord(publicHost(name), targetIP, false); } catch (e) { results.publicError = safeError(e); }
  }
  if (internalDns) {
    await deleteARecord(internalHost(name)).catch(() => {});
    try { results.internal = await createARecord(internalHost(name), intIP, false); } catch (e) { results.internalError = safeError(e); }
  }

  return NextResponse.json({ success: true, ...results });
}
