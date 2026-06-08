import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { validateK8sName } from "@/lib/api-security";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import {
  appendServerAudit,
  forceStopServer,
  getServerDeployment,
  gracefulStopServer,
  isKubernetesNotFoundError,
  makeGameHubClients,
  parseDiscordWebhookConfig,
  readServerEgg,
  sendDiscordWebhook,
} from "@/lib/game-hub-server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";

export async function handlePowerAction(req: NextRequest, name: string, action: "stop" | "force-stop") {
  if (!checkRateLimit(rateLimitKey(`game-hub-${action}`, req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });

  const access = await getGameHubAccessContext(session, 60);
  if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:stop", name)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const clients = makeGameHubClients();
    const deployment = await getServerDeployment(clients.appsApi, name);
    const egg = await readServerEgg(clients.coreApi, name, deployment);
    const webhookConfig = parseDiscordWebhookConfig(deployment.metadata?.annotations?.["infraweaver/discord-webhook"]);

    // Delete any HPA first: an HPA with minReplicas >= 1 immediately scales the
    // deployment back up after we scale to 0, causing the reported
    // stopped -> starting -> running auto-restart. Namespace is hard-scoped and
    // `name` is validated above, so this only ever targets this server's HPA.
    await clients.autoscalingApi.deleteNamespacedHorizontalPodAutoscaler({ name, namespace: GAME_HUB_NAMESPACE }).catch(() => undefined);

    if (action === "stop") {
      const result = await gracefulStopServer(clients, name, egg.stopCommand, 30_000);
      await sendDiscordWebhook(webhookConfig, "stop", `⏹️ ${name} stopped${result.exitedGracefully ? " gracefully" : ""}`);
    } else {
      await forceStopServer(clients, name);
      await sendDiscordWebhook(webhookConfig, "stop", `🛑 ${name} force-stopped`);
    }

    // Power state is intentionally NOT written to git. ArgoCD's
    // `catalog-game-hub-servers` Application ignores `/spec/replicas` drift, so the
    // cluster-only scale-to-0 sticks; committing a manifest here instead triggered
    // an auto-sync that re-applied `replicas` from git (restarting the server) and
    // the slow git round-trip surfaced as "TypeError: Load failed". See the
    // MANIFEST_SYNC_ACTIONS note in route.ts.
    await auditLog(`game-hub:${action}`, session.user?.email ?? "unknown", `${action} ${name}`);
    await appendServerAudit(clients.coreApi, name, {
      timestamp: new Date().toISOString(),
      user: session.user?.email ?? "unknown",
      action,
      details: JSON.stringify({ action }),
    });

    return NextResponse.json({ action, name });
  } catch (error) {
    console.error(`server ${action} failed`, error);
    if (isKubernetesNotFoundError(error)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
