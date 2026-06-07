import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { GAME_HUB_NS, gracefulStopServer, makeGameHubClients, readServerEgg } from "@/lib/game-hub-server";
import { writeServerManifest } from "@/lib/game-hub-manifest";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { isValidK8sName } from "@/lib/validate";
import { safeError } from "@/lib/utils";

const bulkBodySchema = z.object({
  action: z.enum(["start", "stop", "restart", "stop-all"]),
  names: z.array(z.string().min(1)).min(1).optional(),
});

export async function POST(req: NextRequest) {
  if (!checkRateLimit(rateLimitKey("game-hub-bulk", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getGameHubAccessContext(session, 60);
  const rawBody = await req.json().catch(() => ({}));
  const parsed = bulkBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
  }
  const { action } = parsed.data;
  const names = parsed.data.names ?? [];
  if (action !== "stop-all") {
    if (names.length === 0) {
      return NextResponse.json({ error: "names is required" }, { status: 400 });
    }
    const invalidName = names.find((n) => !isValidK8sName(n));
    if (invalidName) {
      return NextResponse.json({ error: `Invalid server name: ${invalidName}` }, { status: 400 });
    }
  }

  try {
    const clients = makeGameHubClients();
    const { appsApi, coreApi } = clients;

    if (action === "stop-all") {
      const deployments = await appsApi.listNamespacedDeployment({ namespace: GAME_HUB_NS });
      const allowedDeployments = (deployments.items ?? []).filter((deployment) => {
        const deploymentName = deployment.metadata?.name ?? "";
        return deploymentName
          && hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:stop", deploymentName);
      });
      const stopped = (await Promise.all(allowedDeployments.map(async (deployment) => {
        const deploymentName = deployment.metadata?.name ?? "";
        if (!deploymentName || (deployment.spec?.replicas ?? 0) <= 0) {
          return null;
        }
        try {
          await appsApi.patchNamespacedDeployment({
            name: deploymentName,
            namespace: GAME_HUB_NS,
            body: { spec: { replicas: 0 } },
            fieldManager: "infraweaver",
          });
          // Persist stopped state to git so ArgoCD selfHeal keeps it stopped.
          await writeServerManifest(deploymentName, clients).catch((gitErr) => {
            console.error(`writeServerManifest failed for stop-all on ${deploymentName}:`, gitErr);
          });
          await auditLog("game-hub:stop-all", session.user?.email ?? "unknown", `stop-all ${deploymentName}`);
          return deploymentName;
        } catch (error) {
          console.error(`bulk stop-all failed for ${deploymentName}`, error);
          return null;
        }
      }))).filter((deploymentName): deploymentName is string => deploymentName !== null);

      return NextResponse.json({ stopped, total: allowedDeployments.length });
    }

    const results = await Promise.all(names.map(async (name) => {
      const permission = action === "start" ? "game-hub:start" : "game-hub:stop";
      if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, permission, name)) {
        return { name, ok: false, error: "Forbidden" };
      }

      try {
        if (action === "restart") {
          const pods = await coreApi.listNamespacedPod({ namespace: GAME_HUB_NS, labelSelector: `app=${name}` });
          await Promise.all((pods.items ?? []).map((pod) => coreApi.deleteNamespacedPod({ name: pod.metadata?.name ?? "", namespace: GAME_HUB_NS }).catch(() => undefined)));
        } else if (action === "stop") {
          const deployment = await appsApi.readNamespacedDeployment({ name, namespace: GAME_HUB_NS });
          const egg = await readServerEgg(coreApi, name, deployment);
          await gracefulStopServer(clients, name, egg.stopCommand, 30_000);
          // Persist stopped state to git so ArgoCD selfHeal keeps it stopped.
          await writeServerManifest(name, clients).catch((gitErr) => {
            console.error(`writeServerManifest failed for bulk stop on ${name}:`, gitErr);
          });
        } else {
          await appsApi.patchNamespacedDeployment({
            name,
            namespace: GAME_HUB_NS,
            body: { spec: { replicas: 1 }, metadata: { annotations: { "infraweaver.io/last-started": new Date().toISOString() } } },
            fieldManager: "infraweaver",

          });
          // Persist running state to git so ArgoCD selfHeal does not stop it again.
          await writeServerManifest(name, clients).catch((gitErr) => {
            console.error(`writeServerManifest failed for bulk start on ${name}:`, gitErr);
          });
        }
        await auditLog(`game-hub:${action}`, session.user?.email ?? "unknown", `${action} ${name}`);
        return { name, ok: true };
      } catch (error) {
        console.error(`bulk ${action} failed for ${name}`, error);
        return { name, ok: false, error: safeError(error) };
      }
    }));

    return NextResponse.json({ action, results });
  } catch (error) {
    console.error("bulk operation failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
