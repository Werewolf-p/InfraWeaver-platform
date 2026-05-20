/**
 * DELETE /api/apps/[name]/uninstall
 *
 * Full uninstall for catalog or platform ArgoCD applications.
 * Unlike the simple ArgoCD delete (which only removes the Application object
 * and gets re-created by the bootstrap App-of-Apps), this also removes the
 * git bootstrap files and catalog/platform directories so the app is truly gone.
 *
 * Supported app name patterns:
 *   catalog-<slug>              → full catalog uninstall (bootstrap + catalog dir)
 *   catalog-<slug>-manifests    → same, extracts slug
 *   platform-<appName>          → removes platform/<appName> dir
 *
 * Protected apps (will return 403):
 *   core-*                      → core infrastructure
 *   appset-*                    → ApplicationSets
 *   bootstrap                   → root bootstrap
 *   catalog-infraweaver-console-manifests  → the console itself
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { validateK8sName } from "@/lib/api-security";
import { auditLog } from "@/lib/audit-log";
import { gitCommitFiles, gitDeleteDir, gitReadFile } from "@/lib/git-provider";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";

const ARGOCD_URL = process.env.ARGOCD_URL ?? "https://argocd.int.rlservers.com";
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? "";

const SAFE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// Apps that must never be deleted from the console
const PROTECTED_APPS = new Set([
  "bootstrap",
  "catalog-infraweaver-console-manifests",
]);
const PROTECTED_PREFIXES = ["core-", "appset-"];


async function argoDelete(argoAppName: string): Promise<void> {
  if (!ARGOCD_TOKEN) return;
  const name = encodeURIComponent(argoAppName);
  const headers = { Authorization: `Bearer ${ARGOCD_TOKEN}` };

  // Remove finalizers first
  await fetch(`${ARGOCD_URL}/api/v1/applications/${name}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/merge-patch+json" },
    body: JSON.stringify({ metadata: { finalizers: [] } }),
  }).catch(() => undefined);

  // Cascade delete
  await fetch(`${ARGOCD_URL}/api/v1/applications/${name}?cascade=true`, {
    method: "DELETE",
    headers,
  }).catch(() => undefined);
}

function isProtected(name: string): boolean {
  if (PROTECTED_APPS.has(name)) return true;
  if (PROTECTED_PREFIXES.some(p => name.startsWith(p))) return true;
  return false;
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "apps:write")) {
    return NextResponse.json({ error: "Forbidden — requires apps:write" }, { status: 403 });
  }
  if (!checkRateLimit(rateLimitKey("apps-uninstall", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { name } = await params;
  const nameErr = validateK8sName(name);
  if (nameErr) return NextResponse.json(nameErr.error, { status: nameErr.status });
  if (!SAFE_NAME_RE.test(name)) {
    return NextResponse.json({ error: "Invalid app name" }, { status: 400 });
  }

  if (isProtected(name)) {
    return NextResponse.json(
      { error: `"${name}" is a protected app and cannot be removed from the console.` },
      { status: 403 }
    );
  }

  const deleted: string[] = [];
  const errors: string[] = [];

  // ── CATALOG APP ──────────────────────────────────────────────────────────────
  if (name.startsWith("catalog-")) {
    // Normalise: catalog-wiki-manifests → wiki, catalog-wiki → wiki
    const slug = name.replace(/^catalog-/, "").replace(/-manifests$/, "");

    // 1. Remove bootstrap files for this slug (batch into one commit)
    const bootstrapFiles = await Promise.all([
      `kubernetes/bootstrap/catalog-${slug}.yaml`,
      `kubernetes/bootstrap/catalog-${slug}-manifests.yaml`,
      `kubernetes/bootstrap/catalog-${slug}-secrets.yaml`,
    ].map(async (f) => ({ path: f, exists: !!(await gitReadFile(f)) })));
    const toDelete = bootstrapFiles.filter((f) => f.exists).map((f) => f.path);
    if (toDelete.length > 0) {
      try {
        await gitCommitFiles({ message: `chore(apps): uninstall ${slug}`, deleteFiles: toDelete });
        deleted.push(...toDelete);
      } catch {
        errors.push(`Failed to delete bootstrap files for ${slug}`);
      }
    }

    // 2. Remove catalog directory (single clone for Onedev)
    const catalogDir = `kubernetes/catalog/${slug}`;
    const dirResult = await gitDeleteDir(catalogDir, `chore(apps): remove ${slug} catalog files`);
    deleted.push(...dirResult.deleted);
    errors.push(...dirResult.errors);

    // 3. Delete ArgoCD applications
    await argoDelete(`catalog-${slug}`);
    await argoDelete(`catalog-${slug}-manifests`);

  // ── PLATFORM APP ─────────────────────────────────────────────────────────────
  } else if (name.startsWith("platform-")) {
    const appName = name.replace(/^platform-/, "");

    // Remove platform directory (contains application.yaml + values.yaml)
    const platformDir = `kubernetes/platform/${appName}`;
    const dirResult = await gitDeleteDir(platformDir, `chore(platform): remove ${appName}`);
    deleted.push(...dirResult.deleted);
    errors.push(...dirResult.errors);

    // Delete ArgoCD application
    await argoDelete(name);

  } else {
    // Unknown prefix — just do an ArgoCD-only delete with a warning
    await argoDelete(name);
    deleted.push(`ArgoCD application: ${name}`);
  }

  await auditLog(
    "apps:uninstall",
    session.user?.email ?? "unknown",
    `app=${name} deleted=${deleted.join(",")}${errors.length ? ` errors=${errors.join(",")}` : ""}`
  );

  if (errors.length > 0 && deleted.length === 0) {
    return NextResponse.json({ error: "Uninstall failed", details: errors }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    message: `"${name}" has been scheduled for removal. Git files deleted; ArgoCD will clean up resources shortly.`,
    deleted,
    errors: errors.length > 0 ? errors : undefined,
  });
}
