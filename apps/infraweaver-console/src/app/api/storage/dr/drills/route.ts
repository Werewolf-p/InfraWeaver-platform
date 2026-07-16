import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/with-auth";
import { auditLog } from "@/lib/audit-log";
import { listDrills, recordDrill } from "@/lib/dr/drill-store";
import { daysSinceLastVerifiedRestore, lastVerifiedByVolume, type DrillEntry } from "@/lib/dr/drill-analysis";

/** GET: the drill log + "days since last verified restore" DR-confidence metric. */
export const GET = withAuth({ permission: "infra:read" }, async () => {
  const entries = await listDrills();
  return NextResponse.json({
    entries,
    daysSinceLastVerifiedRestore: daysSinceLastVerifiedRestore(entries, Date.now()),
    lastVerifiedByVolume: lastVerifiedByVolume(entries),
  });
});

const drillBody = z.object({
  volumeName: z.string().min(1).max(253),
  pvc: z.string().max(253).optional().default(""),
  outcome: z.enum(["verified", "failed", "unverified"]),
  note: z.string().max(500).optional(),
});

/** POST: record a manually-run restore drill. Metadata-only write, gated to admins + audited. */
export const POST = withAuth({ permission: "cluster:admin" }, async ({ req, session }) => {
  const parsed = drillBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid drill entry" }, { status: 400 });
  }

  const user = session.user?.email ?? "unknown";
  const entry: DrillEntry = {
    id: crypto.randomUUID(),
    volumeName: parsed.data.volumeName,
    pvc: parsed.data.pvc,
    outcome: parsed.data.outcome,
    verifiedBy: user,
    note: parsed.data.note,
    timestamp: new Date().toISOString(),
  };

  await recordDrill(entry);
  await auditLog("backup:drill-log", user, `restore drill ${parsed.data.outcome} for ${parsed.data.volumeName}`, {
    req,
    resource: parsed.data.volumeName,
  });

  return NextResponse.json({ entry });
});
