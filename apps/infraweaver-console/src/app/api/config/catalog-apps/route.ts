import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";

export interface CatalogApp {
  name: string;
  description: string;
  host: string;
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "config:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const headers = {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    const dirRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/kubernetes/catalog`,
      { headers, cache: "no-store" }
    );
    if (!dirRes.ok) throw new Error(`GitHub API error: ${dirRes.status}`);
    const entries = await dirRes.json() as Array<{ name: string; type: string }>;
    const dirs = entries.filter((e) => e.type === "dir");

    const apps = await Promise.all(
      dirs.map(async (dir): Promise<CatalogApp> => {
        try {
          const fileRes = await fetch(
            `https://api.github.com/repos/${GITHUB_REPO}/contents/kubernetes/catalog/${dir.name}/catalog.yaml`,
            { headers, cache: "no-store" }
          );
          if (!fileRes.ok) return { name: dir.name, description: "", host: "" };
          const file = await fileRes.json() as { content: string };
          const content = Buffer.from(file.content, "base64").toString("utf-8");
          const yaml = await import("js-yaml");
          const parsed = yaml.load(content) as Record<string, unknown>;
          return {
            name: dir.name,
            description: (parsed?.description as string) ?? "",
            host: (parsed?.["ingressroute.host"] as string) ?? (parsed?.host as string) ?? "",
          };
        } catch {
          return { name: dir.name, description: "", host: "" };
        }
      })
    );

    return NextResponse.json(apps);
  } catch {
    return NextResponse.json([
      { name: "wiki", description: "Wiki.js documentation", host: "wiki.int.rlservers.com" },
      { name: "gatus", description: "Status monitoring", host: "gatus.int.rlservers.com" },
      { name: "stirling-pdf", description: "PDF tools", host: "stirling-pdf.int.rlservers.com" },
      { name: "onedev", description: "Git forge + CI", host: "onedev.rlservers.com" },
      { name: "vaultwarden", description: "Password manager", host: "vaultwarden.int.rlservers.com" },
      { name: "gitea", description: "Self-hosted Git", host: "gitea.int.rlservers.com" },
      { name: "it-tools", description: "IT/Dev tools", host: "it-tools.int.rlservers.com" },
      { name: "excalidraw", description: "Whiteboard", host: "excalidraw.int.rlservers.com" },
      { name: "actual", description: "Personal finance", host: "actual.int.rlservers.com" },
      { name: "outline", description: "Team knowledge base", host: "outline.int.rlservers.com" },
      { name: "jellyfin", description: "Media server", host: "jellyfin.int.rlservers.com" },
    ] as CatalogApp[]);
  }
}
