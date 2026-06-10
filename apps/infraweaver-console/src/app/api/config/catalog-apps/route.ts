import path from "node:path";
import { NextResponse } from "next/server";
import { getGitAccessToken, gitListDir, gitReadFile } from "@/lib/git-provider";
import { withAuth } from "@/lib/with-auth";
import { DEFAULT_CATALOG_APPS } from "@/lib/platform-config";

const GIT_TOKEN = getGitAccessToken();

export interface CatalogApp {
  name: string;
  description: string;
  host: string;
  namespace: string;
}

export const GET = withAuth({ permission: "config:read" }, async () => {
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
    return NextResponse.json(DEFAULT_CATALOG_APPS as CatalogApp[]);
  }
});
