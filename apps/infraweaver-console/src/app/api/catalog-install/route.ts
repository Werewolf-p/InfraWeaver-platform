import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { z } from "zod";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";

async function githubPut(
  path: string,
  content: string,
  message: string,
  sha?: string
) {
  const body: Record<string, unknown> = {
    message,
    content: Buffer.from(content).toString("base64"),
    committer: {
      name: "InfraWeaver Console",
      email: "console@infraweaver.internal",
    },
  };
  if (sha) body.sha = sha;
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${text}`);
  }
  return res.json();
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "catalog:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!checkRateLimit(rateLimitKey("catalog-install", req), 10, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  const CatalogInstallBody = z.object({
    appName: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
    yaml: z.string().min(1).max(50000),
    namespace: z.string().min(1).max(63).regex(/^[a-z0-9-]+$/),
    commitMessage: z.string().max(200).optional(),
  });
  const result = CatalogInstallBody.safeParse(await req.json());
  if (!result.success) return NextResponse.json({ error: result.error.flatten() }, { status: 400 });
  const { appName, yaml, namespace: _namespace, commitMessage } = result.data;
  try {

    // 1. Create the application.yaml file
    await githubPut(
      `kubernetes/catalog/${appName}/application.yaml`,
      yaml,
      commitMessage ?? `feat: add catalog app ${appName} via InfraWeaver Console`
    );

    // 2. Update platform.yaml to add app to catalog.enabled
    const platformRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/platform.yaml`,
      {
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github.v3+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        cache: "no-store",
      }
    );

    if (platformRes.ok) {
      const platformFile = (await platformRes.json()) as {
        content: string;
        sha: string;
      };
      const content = Buffer.from(platformFile.content, "base64").toString("utf-8");
      const jsYaml = await import("js-yaml");
      const parsed = jsYaml.load(content) as Record<string, unknown>;
      const catalog = parsed.catalog as { enabled: string[] };
      if (!catalog.enabled.includes(appName)) {
        catalog.enabled.push(appName);
      }
      const newContent = jsYaml.dump(parsed, { lineWidth: -1, indent: 2 });
      await githubPut(
        "platform.yaml",
        newContent,
        `chore: add ${appName} to catalog.enabled via InfraWeaver Console`,
        platformFile.sha
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
