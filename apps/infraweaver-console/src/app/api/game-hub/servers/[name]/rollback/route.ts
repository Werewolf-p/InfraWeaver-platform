import { NextResponse } from "next/server";
import { GAME_HUB_NAMESPACE } from "@/lib/game-hub";
import { auditServerAction, makeGameHubClients, withGameHubAuth } from "@/lib/game-hub-server";
import { safeError } from "@/lib/utils";

export const POST = withGameHubAuth(
  { permission: "game-hub:admin", rateLimit: { name: "game-hub-rollback", limit: 5, windowMs: 60_000 } },
  async ({ session, name }) => {
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
      await auditServerAction(clients.coreApi, name, session, "rollback", `Rolled back to revision ${prevRevision}`);

      return NextResponse.json({ rolledBack: true, previousRevision: prevRevision });
    } catch (error) {
      console.error("rollback route failed", error);
      return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
  },
);
