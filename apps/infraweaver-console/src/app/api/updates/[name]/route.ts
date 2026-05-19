import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { auditLog } from "@/lib/audit-log";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";
const GITHUB_API = "https://api.github.com";
const HELM_SECTIONS = ["core", "monitoring", "platform"] as const;

// Version: digits, dots, dashes, stars only (covers "9.*", "v1.2.3", "1.7.0")
const VERSION_RE = /^[v*0-9][0-9a-zA-Z.*\-+]*$/;

const updateBodySchema = z.object({
  version: z.string().min(1).max(64).regex(/^[v*0-9][0-9a-zA-Z.*\-+]*$/, "Invalid version format"),
});

function ghHeaders(json = false) {
  const h: Record<string, string> = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github.v3+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (json) h["Content-Type"] = "application/json";
  return h;
}

function parseAppName(name: string): [string, string] | null {
  for (const section of HELM_SECTIONS) {
    const prefix = `${section}-`;
    if (name.startsWith(prefix)) return [section, name.slice(prefix.length)];
  }
  return null;
}

async function readFile(path: string): Promise<{ content: string; sha: string } | null> {
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${path}`, {
    headers: ghHeaders(),
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const data = await res.json() as { content: string; sha: string };
  return { content: Buffer.from(data.content, "base64").toString("utf-8"), sha: data.sha };
}

async function updateFile(path: string, newContent: string, sha: string, message: string): Promise<string> {
  const res = await fetch(`${GITHUB_API}/repos/${GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    headers: ghHeaders(true),
    body: JSON.stringify({
      message,
      content: Buffer.from(newContent).toString("base64"),
      sha,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub write failed (${res.status}): ${err}`);
  }
  const data = await res.json() as { commit: { sha: string } };
  return data.commit.sha;
}

// Replace targetRevision value in the YAML text (line-level edit to preserve comments)
function patchTargetRevision(yaml: string, newVersion: string): string {
  // Matches: `targetRevision: "1.7.*"` or `targetRevision: 1.7.*` with optional quotes
  const patched = yaml.replace(
    /^(targetRevision\s*:\s*)["']?[^"'\n]+["']?/m,
    `$1"${newVersion}"`
  );
  if (patched === yaml) {
    // targetRevision line not found; append it (edge case)
    return yaml.trimEnd() + `\ntargetRevision: "${newVersion}"\n`;
  }
  return patched;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "apps:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!checkRateLimit(rateLimitKey("updates-apply", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  if (!GITHUB_TOKEN) {
    return NextResponse.json({ error: "Git token not configured" }, { status: 500 });
  }

  const { name } = await params;
  // Validate name is safe
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return NextResponse.json({ error: "Invalid app name" }, { status: 400 });
  }

  const rawBody = await req.json().catch(() => ({}));
  const parsed = updateBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", details: parsed.error.flatten() }, { status: 400 });
  }
  const { version } = parsed.data;

  // Extra guard: ensure version only contains safe chars
  if (!VERSION_RE.test(version)) {
    return NextResponse.json({ error: "Invalid version format" }, { status: 400 });
  }

  const parts = parseAppName(name);
  if (!parts) {
    return NextResponse.json({ error: "App not found in managed sections (core/monitoring/platform)" }, { status: 404 });
  }
  const [section, appDir] = parts;
  const filePath = `kubernetes/${section}/${appDir}/application.yaml`;

  const file = await readFile(filePath);
  if (!file) {
    return NextResponse.json({ error: `application.yaml not found at ${filePath}` }, { status: 404 });
  }

  const patched = patchTargetRevision(file.content, version);
  if (patched === file.content) {
    return NextResponse.json({ success: true, message: `${name} already at ${version} — no change needed`, commitSha: null });
  }

  try {
    const commitSha = await updateFile(
      filePath,
      patched,
      file.sha,
      `chore(updates): bump ${name} targetRevision to ${version}`
    );
    await auditLog("updates:apply", session.user?.email ?? "unknown", `app=${name} version=${version} commit=${commitSha}`);
    return NextResponse.json({
      success: true,
      message: `Updated ${name} → ${version}. ArgoCD will sync automatically.`,
      commitSha,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
