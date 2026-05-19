import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getGitAccessToken, gitCommitFiles, gitReadFile } from "@/lib/git-provider";
import { hasPermission } from "@/lib/rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { safeError } from "@/lib/utils";
import { z } from "zod";

const GIT_TOKEN = getGitAccessToken();

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "catalog:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!checkRateLimit(rateLimitKey("catalog-install", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const CatalogInstallBody = z.object({
    appName: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
    yaml: z.string().min(1).max(50_000),
    namespace: z.string().min(1).max(63).regex(/^[a-z0-9-]+$/),
    commitMessage: z.string().max(200).optional(),
  });

  const result = CatalogInstallBody.safeParse(await req.json());
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });

  const { appName, yaml, commitMessage } = result.data;

  try {
    if (!GIT_TOKEN) throw new Error("Missing git provider token");

    const filesToWrite = [
      {
        path: `kubernetes/catalog/${appName}/application.yaml`,
        content: yaml,
      },
    ];

    const platformFile = await gitReadFile("platform.yaml");
    if (platformFile) {
      const yamlLib = await import("js-yaml");
      const parsed = yamlLib.load(platformFile.content) as Record<string, unknown>;
      const catalog = ((parsed.catalog as { enabled?: string[] } | undefined) ?? { enabled: [] });
      catalog.enabled ??= [];
      if (!catalog.enabled.includes(appName)) catalog.enabled.push(appName);
      parsed.catalog = catalog;
      filesToWrite.push({
        path: "platform.yaml",
        content: yamlLib.dump(parsed, { lineWidth: -1, indent: 2 }),
      });
    }

    await gitCommitFiles({
      message: commitMessage ?? `feat: add catalog app ${appName} via InfraWeaver Console`,
      addOrUpdateFiles: filesToWrite,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
