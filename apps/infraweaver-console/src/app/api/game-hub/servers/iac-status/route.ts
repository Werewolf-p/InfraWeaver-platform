import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext } from "@/lib/game-hub";
import { makeGameHubClients } from "@/lib/game-hub-server";
import { getGitAccessToken, gitListDir } from "@/lib/git-provider";
import { hasPermission } from "@/lib/rbac";
import { safeError } from "@/lib/utils";

const GIT_TOKEN = getGitAccessToken();
const GIT_SERVERS_PATH = "kubernetes/catalog/game-hub/servers";

/** List files in the git servers directory. Returns [] if the directory doesn't exist yet. */
async function listGitServerManifests(): Promise<Set<string>> {
  if (!GIT_TOKEN) return new Set();
  const files = await gitListDir(GIT_SERVERS_PATH);
  return new Set(
    files
      .filter((file) => file.type === "file" && file.path.endsWith(".yaml"))
      .map((file) => file.path.split("/").pop()?.slice(0, -5) ?? "")
      .filter(Boolean),
  );
}

/**
 * GET /api/game-hub/servers/iac-status
 *
 * Returns which game servers currently have a manifest committed to git.
 * Response: { servers: { [name: string]: boolean } }
 */
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getGameHubAccessContext(session, 60);
  if (!hasPermission(access.groups, "game-hub:read", access.roleAssignments, "/game-hub/", access.username)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { appsApi } = makeGameHubClients();
    const [deployments, gitNames] = await Promise.all([
      appsApi.listNamespacedDeployment({
        namespace: GAME_HUB_NAMESPACE,
        labelSelector: "infraweaver/game=true",
      }),
      listGitServerManifests(),
    ]);

    const servers: Record<string, boolean> = {};
    for (const deployment of deployments.items ?? []) {
      const name = deployment.metadata?.name ?? "";
      if (name) servers[name] = gitNames.has(name);
    }

    return NextResponse.json({ servers });
  } catch (error) {
    console.error("iac-status failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
