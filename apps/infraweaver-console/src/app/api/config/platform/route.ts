import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";
const PLATFORM_FILE_PATH = "platform.yaml";

async function getFileFromGitHub() {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${PLATFORM_FILE_PATH}`,
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    }
  );
  if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
  return res.json();
}

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "config:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const file = await getFileFromGitHub();
    const content = Buffer.from(file.content, "base64").toString("utf-8");
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
        "core-monitoring": { enabled: true },
        "core-platform": { enabled: true },
      },
    });
  }
}

export async function PUT(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "config:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const body = await req.json() as { changes?: string[]; yamlContent?: string; commitMessage?: string };
    const file = await getFileFromGitHub();
    let newContent: string;

    if (body.yamlContent !== undefined) {
      newContent = body.yamlContent;
    } else {
      const content = Buffer.from(file.content, "base64").toString("utf-8");
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
    const updateRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${PLATFORM_FILE_PATH}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: commitMessage,
          content: Buffer.from(newContent).toString("base64"),
          sha: file.sha,
          committer: {
            name: "InfraWeaver Console",
            email: "console@infraweaver.internal",
          },
        }),
      }
    );
    if (!updateRes.ok) throw new Error("GitHub PUT failed");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
