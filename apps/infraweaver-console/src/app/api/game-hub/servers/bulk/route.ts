import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { GAME_HUB_NS, makeGameHubClients } from "@/lib/game-hub-server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

export async function POST(req: NextRequest) {
  if (!checkRateLimit(rateLimitKey("game-hub-bulk", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getGameHubAccessContext(session, 60);
  const body = await req.json() as { action: "start" | "stop" | "restart"; names: string[] };
  const names = Array.isArray(body.names) ? body.names.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : [];
  if (!body.action || names.length === 0) {
    return NextResponse.json({ error: "action and names are required" }, { status: 400 });
  }

  try {
    const { appsApi, coreApi } = makeGameHubClients();
    const results = await Promise.all(names.map(async (name) => {
      const permission = body.action === "start" ? "game-hub:start" : "game-hub:stop";
      if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, permission, name)) {
        return { name, ok: false, error: "Forbidden" };
      }

      try {
        if (body.action === "restart") {
          const pods = await coreApi.listNamespacedPod({ namespace: GAME_HUB_NS, labelSelector: `app=${name}` });
          await Promise.all((pods.items ?? []).map((pod) => coreApi.deleteNamespacedPod({ name: pod.metadata?.name ?? "", namespace: GAME_HUB_NS }).catch(() => undefined)));
        } else {
          await appsApi.patchNamespacedDeployment({
            name,
            namespace: GAME_HUB_NS,
            body: { spec: { replicas: body.action === "start" ? 1 : 0 } },
            fieldManager: "infraweaver",
            force: true,
          });
        }
        await auditLog(`game-hub:${body.action}`, session.user?.email ?? "unknown", `${body.action} ${name}`);
        return { name, ok: true };
      } catch (error) {
        console.error(`bulk ${body.action} failed for ${name}`, error);
        return { name, ok: false, error: safeError(error) };
      }
    }));

    return NextResponse.json({ action: body.action, results });
  } catch (error) {
    console.error("bulk operation failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
