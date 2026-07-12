import { NextResponse } from "next/server";
import { z } from "zod";
import { auditLog } from "@/lib/audit-log";
import { invalidateClusterCaches } from "@/lib/performance-cache";
import { requireSingleCluster } from "@/lib/route-utils";
import { safeError } from "@/lib/utils";
import { withAuth } from "@/lib/with-auth";
import { loadGroups, powerApp, powerGroup } from "@/lib/app-power";

const schema = z.object({
  action: z.enum(["stop", "start"]),
  // Target either a single app, an explicit app list, or a saved group by id.
  app: z.string().min(1).max(253).optional(),
  apps: z.array(z.string().min(1).max(253)).max(100).optional(),
  groupId: z.string().uuid().optional(),
});

export const POST = withAuth(
  { permission: "cluster:admin", rateLimit: { name: "app-power", limit: 30, windowMs: 60_000 } },
  async ({ req, session }) => {
    const parsed = schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    const { action, app, apps, groupId } = parsed.data;

    const cluster = requireSingleCluster(req, "Select a specific cluster before powering apps");
    if (cluster instanceof NextResponse) return cluster;
    const { clusterId } = cluster;

    // Resolve the target app list.
    let targets: string[] = [];
    if (groupId) {
      const group = (await loadGroups()).find((g) => g.id === groupId);
      if (!group) return NextResponse.json({ error: "Group not found" }, { status: 404 });
      targets = group.apps;
    } else if (apps?.length) {
      targets = apps;
    } else if (app) {
      targets = [app];
    } else {
      return NextResponse.json({ error: "Provide app, apps, or groupId" }, { status: 400 });
    }
    if (targets.length === 0) return NextResponse.json({ error: "No apps to power" }, { status: 400 });

    try {
      const results = targets.length === 1
        ? [await powerApp(clusterId, targets[0], action)]
        : await powerGroup(clusterId, targets, action);
      await auditLog("app-power", session.user?.email ?? "unknown", `${action} ${targets.join(", ")}`);
      invalidateClusterCaches();
      return NextResponse.json({ ok: true, results });
    } catch (err) {
      return NextResponse.json({ ok: false, error: safeError(err) }, { status: 502 });
    }
  },
);
