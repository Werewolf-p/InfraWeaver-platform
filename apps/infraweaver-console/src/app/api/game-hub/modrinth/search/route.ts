import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getGameHubAccessContext, hasGameHubPermission } from "@/lib/game-hub";
import { getServerDeployment, makeGameHubClients, readServerEgg } from "@/lib/game-hub-server";
import { safeError } from "@/lib/utils";

interface ModrinthSearchResponse {
  hits?: Array<{
    project_id?: string;
    title?: string;
    description?: string;
    downloads?: number;
    icon_url?: string | null;
    versions?: string[];
  }>;
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const serverName = req.nextUrl.searchParams.get("server")?.trim() ?? "";
  const access = await getGameHubAccessContext(session, 60);

  if (serverName) {
    if (!hasGameHubPermission(access.groups, access.username, access.roleAssignments, "game-hub:read", serverName)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    try {
      const { appsApi, coreApi } = makeGameHubClients();
      const deployment = await getServerDeployment(appsApi, serverName);
      const egg = await readServerEgg(coreApi, serverName, deployment);
      if (!egg.supportsModrinth) {
        return NextResponse.json({ error: "This server does not support Modrinth search" }, { status: 403 });
      }
    } catch (error) {
      return NextResponse.json({ error: safeError(error) }, { status: 500 });
    }
  } else {
    const { hasPermission } = await import("@/lib/rbac");
    if (!hasPermission(access.groups, "game-hub:read", access.roleAssignments, "/game-hub/", access.username)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const query = req.nextUrl.searchParams.get("query")?.trim() ?? "";
  const type = req.nextUrl.searchParams.get("type") === "plugin" ? "plugin" : "mod";
  if (!query) return NextResponse.json({ projects: [] });

  try {
    const facets = encodeURIComponent(JSON.stringify([[`project_type:${type}`]]));
    const response = await fetch(`https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&facets=${facets}`, {
      headers: { "User-Agent": "InfraWeaver Console" },
      next: { revalidate: 300 },
    });
    if (!response.ok) throw new Error(`Modrinth returned ${response.status}`);
    const data = await response.json() as ModrinthSearchResponse;
    return NextResponse.json({
      projects: (data.hits ?? []).map((project) => ({
        id: project.project_id ?? "",
        title: project.title ?? "Unknown",
        description: project.description ?? "",
        downloads: project.downloads ?? 0,
        icon_url: project.icon_url ?? null,
        versions: project.versions ?? [],
      })),
    });
  } catch (error) {
    console.error("modrinth search failed", error);
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
