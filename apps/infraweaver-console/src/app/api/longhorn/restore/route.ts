import { NextResponse } from "next/server";
import { auditLog } from "@/lib/audit-log";
import { getRequestClusterId } from "@/lib/cluster-context";
import { iwApiFetch } from "@/lib/iw-api";
import { withAuth } from "@/lib/with-auth";
import { z } from "zod";

const RestoreBody = z.object({
  volumeName: z.string().min(1).max(253),
  backupURL: z.string().min(1).max(1024),
  targetVolumeName: z.string().max(253).optional(),
});

/** POST /api/longhorn/restore — trigger a Longhorn volume restore via infraweaver-api */
export const POST = withAuth({ permission: "cluster:admin" }, async ({ req, session }) => {
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

  const res = await iwApiFetch("/longhorn/restore", session, getRequestClusterId(req), {
    method: "POST",
    body: JSON.stringify(parsed.data),
  });
  const data = await res.json();

  if (res.ok) {
    await auditLog(
      "longhorn:restore",
      session.user?.email ?? "unknown",
      `volume=${parsed.data.volumeName} backupURL=${parsed.data.backupURL}${parsed.data.targetVolumeName ? " target=" + parsed.data.targetVolumeName : ""}`,
    );
  }

  return NextResponse.json(data, { status: res.status });
});
