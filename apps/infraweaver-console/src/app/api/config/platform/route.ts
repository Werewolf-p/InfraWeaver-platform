import { NextResponse } from "next/server";
import { getGitAccessToken, gitReadFile, gitWriteFile } from "@/lib/git-provider";
import { withAuth } from "@/lib/with-auth";
import { safeError } from "@/lib/utils";
import { z } from "zod";

const PlatformUpdateSchema = z.object({
  changes: z.array(z.string().min(1).max(256)).max(100).optional(),
  yamlContent: z.string().max(512 * 1024).optional(),
  commitMessage: z.string().max(256).optional(),
});

const GIT_TOKEN = getGitAccessToken();
const PLATFORM_FILE_PATH = "platform.yaml";

async function getPlatformFile() {
  const file = await gitReadFile(PLATFORM_FILE_PATH);
  if (!file) throw new Error(`${PLATFORM_FILE_PATH} not found`);
  return file;
}

export const GET = withAuth({ permission: "config:read" }, async () => {
  try {
    if (!GIT_TOKEN) throw new Error("Missing git provider token");
    const file = await getPlatformFile();
    const content = file.content;
    const yaml = await import("js-yaml");
    const parsed = yaml.load(content) as Record<string, unknown>;
    return NextResponse.json({
      raw: content,
      sha: file.sha,
      catalog: (parsed?.catalog as Record<string, unknown>) ?? {},
      groups: (parsed?.groups as Record<string, unknown>) ?? {},
    });
  } catch {
    return NextResponse.json({
      raw: "# platform.yaml not available\ncatalog:\n  enabled: []\n",
      sha: "",
      catalog: { enabled: ["wiki", "gatus", "stirling-pdf", "onedev"] },
      groups: {
        "core-monitoring": { enabled: false },
        "core-platform": { enabled: true },
      },
    });
  }
});

export const PUT = withAuth({ permission: "config:write" }, async ({ req }) => {
  try {
    const parsed = PlatformUpdateSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const body = parsed.data;
    if (!GIT_TOKEN) throw new Error("Missing git provider token");
    const file = await getPlatformFile();
    let newContent: string;

    if (body.yamlContent !== undefined) {
      newContent = body.yamlContent;
    } else {
      const content = file.content;
      const yaml = await import("js-yaml");
      const parsed = yaml.load(content) as Record<string, unknown>;
      const catalog = parsed.catalog as { enabled: string[] };
      for (const change of (body.changes ?? []) as string[]) {
        if (change.startsWith("Enable ")) {
          const appName = change.replace("Enable ", "");
          if (!catalog.enabled.includes(appName)) {
            catalog.enabled.push(appName);
          }
        } else if (change.startsWith("Disable ")) {
          const appName = change.replace("Disable ", "");
          catalog.enabled = catalog.enabled.filter((a: string) => a !== appName);
        }
      }
      const yamlLib = await import("js-yaml");
      newContent = yamlLib.dump(parsed, { lineWidth: -1, indent: 2 });
    }

    const commitMessage = body.commitMessage ?? "chore: update platform.yaml via InfraWeaver Console";
    await gitWriteFile(PLATFORM_FILE_PATH, newContent, commitMessage, file.sha);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
});
