import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getRequestClusterId } from "@/lib/cluster-context";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { iwApiFetch } from "@/lib/iw-api";

/** GET /api/longhorn/backups/[volumeName] — list backups for a specific volume via infraweaver-api */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ volumeName: string }> },
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session);
  if (!hasSessionPermission(access, "cluster:read")) {
    return NextResponse.json({ error: "Forbidden: cluster:read required" }, { status: 403 });
  }

  const { volumeName } = await params;
  if (!volumeName || !/^[a-zA-Z0-9_.-]+$/.test(volumeName)) {
    return NextResponse.json({ error: "Invalid volumeName" }, { status: 400 });
  }

  const res = await iwApiFetch(
    `/longhorn/backups/${encodeURIComponent(volumeName)}`,
    session,
    getRequestClusterId(req),
  );
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
