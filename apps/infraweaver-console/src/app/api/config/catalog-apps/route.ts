import path from "node:path";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getGitAccessToken, gitListDir, gitReadFile } from "@/lib/git-provider";
import { hasPermission } from "@/lib/rbac";

const GIT_TOKEN = getGitAccessToken();

export interface CatalogApp {
  name: string;
  description: string;
  host: string;
  namespace: string;
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "config:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    if (!GIT_TOKEN) throw new Error("Missing git provider token");

    const entries = await gitListDir("kubernetes/catalog");
    const dirs = entries.filter((entry) => entry.type === "dir");

    const apps = await Promise.all(
      dirs.map(async (dir): Promise<CatalogApp> => {
        const dirName = path.posix.basename(dir.path);
        try {
          const file = await gitReadFile(`kubernetes/catalog/${dirName}/catalog.yaml`);
          if (!file) return { name: dirName, description: "", host: "", namespace: dirName };
          const yaml = await import("js-yaml");
          const parsed = yaml.load(file.content) as Record<string, unknown>;
          return {
            name: dirName,
            description: (parsed?.description as string) ?? "",
            host: (parsed?.["ingressroute.host"] as string) ?? (parsed?.ingressroute as Record<string, string>)?.host ?? (parsed?.host as string) ?? "",
            namespace: (parsed?.namespace as string) ?? dirName,
          };
        } catch {
          return { name: dirName, description: "", host: "", namespace: dirName };
        }
      })
    );

    return NextResponse.json(apps);
  } catch {
    return NextResponse.json([
      { name: "gatus", description: "Status monitoring", host: "gatus.int.rlservers.com", namespace: "gatus" },
      { name: "stirling-pdf", description: "PDF tools", host: "stirling-pdf.int.rlservers.com", namespace: "stirling-pdf" },
      { name: "onedev", description: "Git forge + CI", host: "onedev.rlservers.com", namespace: "onedev" },
      { name: "vaultwarden", description: "Password manager", host: "vaultwarden.int.rlservers.com", namespace: "vaultwarden" },
      { name: "jellyfin", description: "Media server", host: "jellyfin.int.rlservers.com", namespace: "jellyfin" },
      { name: "n8n", description: "Workflow automation", host: "n8n.int.rlservers.com", namespace: "n8n" },
      { name: "actual", description: "Personal finance", host: "actual.int.rlservers.com", namespace: "actual" },
    ] as CatalogApp[]);
  }
}
