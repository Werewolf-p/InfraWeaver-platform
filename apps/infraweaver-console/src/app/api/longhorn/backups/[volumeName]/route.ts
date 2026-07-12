import { NextResponse } from "next/server";
import { getRequestClusterId } from "@/lib/cluster-context";
import { iwApiFetch } from "@/lib/iw-api";
import { withAuth } from "@/lib/with-auth";

/** GET /api/longhorn/backups/[volumeName] — list backups for a specific volume via infraweaver-api */
export const GET = withAuth<{ volumeName: string }>({ permission: "cluster:read" }, async ({ req, session, params }) => {
  const { volumeName } = params;
  if (!volumeName || !/^[a-zA-Z0-9_.-]+$/.test(volumeName)) {
    return NextResponse.json({ error: "Invalid volumeName" }, { status: 400 });
  }

  const res = await iwApiFetch(
    `/longhorn/backups/${encodeURIComponent(volumeName)}`,
    session,
    getRequestClusterId(req),
  );
  return NextResponse.json(await res.json(), { status: res.status });
});
