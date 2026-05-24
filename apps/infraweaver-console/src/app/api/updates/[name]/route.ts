import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { auditLog } from "@/lib/audit-log";
import { getGitAccessToken, gitWriteFile } from "@/lib/git-provider";
import { patchTargetRevision, readManagedApplicationFile } from "@/lib/update-manager";

// Version: digits, dots, dashes, stars only (covers "9.*", "v1.2.3", "1.7.0")
const VERSION_RE = /^[v*0-9][0-9a-zA-Z.*\-+]*$/;

const updateBodySchema = z.object({
  version: z.string().min(1).max(64).regex(/^[v*0-9][0-9a-zA-Z.*\-+]*$/, "Invalid version format"),
});


export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "platform:update")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!checkRateLimit(rateLimitKey("updates-apply", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }
  if (!getGitAccessToken().trim()) {
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

  const managedFile = await readManagedApplicationFile(name);
  if (!managedFile) {
    return NextResponse.json({ error: `application.yaml not found for ${name}` }, { status: 404 });
  }

  const patched = patchTargetRevision(managedFile.file.content, version);
  if (patched === managedFile.file.content) {
    return NextResponse.json({ success: true, message: `${name} already at ${version} — no change needed`, commitSha: null });
  }

  try {
    await gitWriteFile(
      managedFile.path,
      patched,
      `chore(updates): bump ${name} targetRevision to ${version}`,
      managedFile.file.sha,
    );
    await auditLog("updates:apply", session.user?.email ?? "unknown", `app=${name} version=${version}`);
    return NextResponse.json({
      success: true,
      message: `Updated ${name} → ${version}. ArgoCD will sync automatically.`,
      commitSha: null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
