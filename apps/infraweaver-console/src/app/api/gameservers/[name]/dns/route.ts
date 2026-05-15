import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getARecord, createARecord, deleteARecord } from "@/lib/cloudflare";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "game-hub:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { name } = await params;

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
    getARecord(`${name}.rlservers.com`).catch(() => null),
    getARecord(`${name}.int.rlservers.com`).catch(() => null),
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
  const { targetIP, internalIP, publicDns, internalDns } = await req.json() as { targetIP: string; internalIP?: string; publicDns: boolean; internalDns: boolean };

  const results: Record<string, unknown> = {};
  const intIP = internalIP || targetIP;

  if (publicDns) {
    await deleteARecord(`${name}.rlservers.com`).catch(() => {});
    try { results.public = await createARecord(`${name}.rlservers.com`, targetIP, false); } catch (e) { results.publicError = safeError(e); }
  }
  if (internalDns) {
    await deleteARecord(`${name}.int.rlservers.com`).catch(() => {});
    try { results.internal = await createARecord(`${name}.int.rlservers.com`, intIP, false); } catch (e) { results.internalError = safeError(e); }
  }

  return NextResponse.json({ success: true, ...results });
}
