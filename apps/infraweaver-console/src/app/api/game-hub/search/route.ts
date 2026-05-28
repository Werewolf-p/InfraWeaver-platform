import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { getDeploymentGameType, makeGameHubClients } from "@/lib/game-hub-server";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { hasPermission } from "@/lib/rbac";
import { safeError } from "@/lib/utils";

function serverStatus(deployment: { metadata?: { annotations?: Record<string, string> }; spec?: { replicas?: number }; status?: { readyReplicas?: number; replicas?: number } }) {
  if (deployment.metadata?.annotations?.["infraweaver/maintenance"] === "true") return "maintenance";
  if ((deployment.spec?.replicas ?? 0) === 0) return "stopped";
  if ((deployment.status?.readyReplicas ?? 0) > 0) return "running";
  if ((deployment.status?.replicas ?? 0) > 0) return "starting";
  return "stopped";
}

export async function GET(req: NextRequest) {
  if (!checkRateLimit(rateLimitKey("game-hub-search", req), 20, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getGameHubAccessContext(session, 60);
  if (!hasPermission(access.groups, "game-hub:read", access.roleAssignments, "/game-hub/", access.username)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const query = req.nextUrl.searchParams.get("q")?.trim().toLowerCase() ?? "";
  if (!query) return NextResponse.json({ results: [] });

  try {
    const { appsApi } = makeGameHubClients();
    const deployments = await appsApi.listNamespacedDeployment({
      namespace: GAME_HUB_NAMESPACE,
      labelSelector: "infraweaver/game=true",
    });

    const results = (deployments.items ?? []).flatMap((deployment) => {
      const name = deployment.metadata?.name ?? "";
      if (!name) return [] as Array<{ name: string; gameType: string; status: string; tags: string[]; description: string; matchedOn: string[] }>;
      if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", name)) {
        return [] as Array<{ name: string; gameType: string; status: string; tags: string[]; description: string; matchedOn: string[] }>;
      }

      const description = deployment.metadata?.annotations?.["infraweaver.io/description"] ?? deployment.metadata?.annotations?.["infraweaver/description"] ?? "";
      const tagsRaw = deployment.metadata?.annotations?.["infraweaver.io/tags"] ?? deployment.metadata?.annotations?.["infraweaver/tags"] ?? "";
      const tags = tagsRaw ? tagsRaw.split(",").map((tag) => tag.trim()).filter(Boolean) : [];
      const gameType = getDeploymentGameType(deployment);
      const matchedOn = [
        name.toLowerCase().includes(query) ? "name" : null,
        gameType.toLowerCase().includes(query) ? "gameType" : null,
        description.toLowerCase().includes(query) ? "description" : null,
        tags.some((tag) => tag.toLowerCase().includes(query)) ? "tags" : null,
      ].filter((value): value is string => value !== null);
      if (matchedOn.length === 0) return [] as Array<{ name: string; gameType: string; status: string; tags: string[]; description: string; matchedOn: string[] }>;

      return [{
        name,
        gameType,
        status: serverStatus(deployment),
        tags,
        description,
        matchedOn,
      }];
    });

    return NextResponse.json({ results });
  } catch (error) {
    console.error("game hub search failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
