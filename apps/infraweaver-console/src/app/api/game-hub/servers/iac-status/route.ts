import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { GAME_HUB_NAMESPACE, getGameHubAccessContext } from "@/lib/game-hub";
import { makeGameHubClients } from "@/lib/game-hub-server";
import { hasPermission } from "@/lib/rbac";
import { safeError } from "@/lib/utils";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";
const GIT_SERVERS_PATH = "kubernetes/catalog/game-hub/servers";

/** List files in the git servers directory. Returns [] if the directory doesn't exist yet. */
async function listGitServerManifests(): Promise<Set<string>> {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${GIT_SERVERS_PATH}`,
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
      },
      cache: "no-store",
    },
  );
  if (res.status === 404) return new Set();
  if (!res.ok) throw new Error(`GitHub GET ${GIT_SERVERS_PATH}: ${res.status}`);
  const files = await res.json() as Array<{ name: string; type: string }>;
  return new Set(
    files
      .filter((f) => f.type === "file" && f.name.endsWith(".yaml"))
      .map((f) => f.name.slice(0, -5)), // strip .yaml
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
