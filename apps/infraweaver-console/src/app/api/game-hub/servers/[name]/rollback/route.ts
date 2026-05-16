import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { appendServerAudit, makeGameHubClients } from "@/lib/game-hub-server";
import { validateK8sName } from "@/lib/api-security";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  if (!checkRateLimit(rateLimitKey("game-hub-rollback", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name } = await params;
  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });
  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:admin", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const clients = makeGameHubClients();
    const rsList = await clients.appsApi.listNamespacedReplicaSet({
      namespace: GAME_HUB_NAMESPACE,
      labelSelector: `app=${name}`,
    });

    const sorted = (rsList.items ?? [])
      .filter((rs) => rs.metadata?.annotations?.["deployment.kubernetes.io/revision"])
      .sort((a, b) => {
        const ra = parseInt(a.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? "0", 10);
        const rb = parseInt(b.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? "0", 10);
        return rb - ra;
      });

    if (sorted.length < 2) {
      return NextResponse.json({ error: "No previous revision to roll back to" }, { status: 400 });
    }

    const previousRs = sorted[1]!;
    const previousTemplate = previousRs.spec?.template;
    if (!previousTemplate) {
      return NextResponse.json({ error: "Previous ReplicaSet has no pod template" }, { status: 400 });
    }

    await clients.appsApi.patchNamespacedDeployment({
      name,
      namespace: GAME_HUB_NAMESPACE,
      body: { spec: { template: previousTemplate } },

      fieldManager: "infraweaver",
    });

    const prevRevision = previousRs.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? "unknown";
    await auditLog("game-hub:rollback", session.user?.email ?? "unknown", `rolled back ${name} to revision ${prevRevision}`);
    await appendServerAudit(clients.coreApi, name, {
      timestamp: new Date().toISOString(),
      user: session.user?.email ?? "unknown",
      action: "rollback",
      details: `Rolled back to revision ${prevRevision}`,
    });

    return NextResponse.json({ rolledBack: true, previousRevision: prevRevision });
  } catch (error) {
    console.error("rollback route failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
