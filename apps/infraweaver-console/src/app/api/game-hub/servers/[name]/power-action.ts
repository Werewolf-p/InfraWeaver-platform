import { NextRequest, NextResponse, after } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { validateK8sName } from "@/lib/api-security";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { writeServerManifest } from "@/lib/game-hub-manifest";
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

    if (action === "stop") {
      const result = await gracefulStopServer(clients, name, egg.stopCommand, 30_000);
      await sendDiscordWebhook(webhookConfig, "stop", `⏹️ ${name} stopped${result.exitedGracefully ? " gracefully" : ""}`);
    } else {
      await forceStopServer(clients, name);
      await sendDiscordWebhook(webhookConfig, "stop", `🛑 ${name} force-stopped`);
    }

    // Persist the stopped state to git so ArgoCD selfHeal does not restart the
    // server back to the git desired state. This runs in `after()` (not inline):
    // the GitHub round-trips are slow enough that awaiting them inline dropped the
    // browser connection ("TypeError: Load failed"), and a torn-down request left
    // the git write unfinished — so git kept `replicas: 1` and ArgoCD scaled the
    // server back up right after Stop (feedback df5a9e3b). `after()` runs once the
    // response is sent, independent of the client, so the write reliably lands.
    after(async () => {
      try {
        await writeServerManifest(name, clients);
      } catch (gitErr) {
        console.error(`writeServerManifest failed for ${action} on ${name}:`, gitErr);
      }
    });

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
