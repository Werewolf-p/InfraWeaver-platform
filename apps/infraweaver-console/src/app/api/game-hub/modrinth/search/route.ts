import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
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
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "game-hub:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
