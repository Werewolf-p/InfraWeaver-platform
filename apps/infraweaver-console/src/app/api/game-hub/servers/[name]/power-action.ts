import { NextResponse } from "next/server";
import { GAME_HUB_NAMESPACE } from "@/lib/game-hub";
import {
  auditServerAction,
  forceStopServer,
  getServerDeployment,
  gracefulStopServer,
  makeGameHubClients,
  parseDiscordWebhookConfig,
  readServerEgg,
  sendDiscordWebhook,
  toApiErrorResponse,
  withGameHubAuth,
} from "@/lib/game-hub-server";

export function makePowerActionRoute(action: "stop" | "force-stop") {
  return withGameHubAuth(
    { permission: "game-hub:stop", rateLimit: { name: `game-hub-${action}`, limit: 20, windowMs: 60_000 } },
    async ({ session, name }) => {
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
        await auditServerAction(clients.coreApi, name, session, action, JSON.stringify({ action }));

        return NextResponse.json({ action, name });
      } catch (error) {
        return toApiErrorResponse(error, `server ${action} failed`);
      }
    },
  );
}
