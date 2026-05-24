import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { getRequestClusterId } from "@/lib/cluster-context";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { iwApiFetch } from "@/lib/iw-api";
import { z } from "zod";

const RestoreBody = z.object({
  volumeName: z.string().min(1).max(253),
  backupURL: z.string().min(1).max(1024),
  targetVolumeName: z.string().max(253).optional(),
});

/** POST /api/longhorn/restore — trigger a Longhorn volume restore via infraweaver-api */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "cluster:admin")) {
    return NextResponse.json({ error: "Forbidden: cluster:admin required" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = RestoreBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }

  const clusterId = getRequestClusterId(req);
  const res = await iwApiFetch("/longhorn/restore", session, clusterId, {
    method: "POST",
    body: JSON.stringify(parsed.data),
  });
  const data = await res.json();

  if (res.ok) {
    await auditLog(session, "longhorn.restore", {
      volumeName: parsed.data.volumeName,
      backupURL: parsed.data.backupURL,
      targetVolumeName: parsed.data.targetVolumeName,
    });
  }

  return NextResponse.json(data, { status: res.status });
}
