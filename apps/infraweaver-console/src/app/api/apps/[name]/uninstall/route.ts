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
import { auditLog } from "@/lib/audit-log";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";
const GH_API = `https://api.github.com/repos/${GITHUB_REPO}`;
const ARGOCD_URL = process.env.ARGOCD_URL ?? "https://argocd.int.rlservers.com";
const ARGOCD_TOKEN = process.env.ARGOCD_TOKEN ?? "";

const SAFE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// Apps that must never be deleted from the console
const PROTECTED_APPS = new Set([
  "bootstrap",
  "catalog-infraweaver-console-manifests",
]);
const PROTECTED_PREFIXES = ["core-", "appset-"];

interface GHFileContent {
  sha: string;
}

interface GHTreeItem {
  path: string;
  type: string;
  sha: string;
}

async function ghGetFileSha(path: string): Promise<string | null> {
  const res = await fetch(`${GH_API}/contents/${path}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" },
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const data = (await res.json()) as GHFileContent;
  return data.sha ?? null;
}

async function ghDeleteFile(path: string, message: string, sha: string): Promise<boolean> {
  const res = await fetch(`${GH_API}/contents/${path}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message, sha }),
  });
  return res.ok;
}

async function ghListDir(dirPath: string): Promise<GHTreeItem[]> {
  const res = await fetch(`${GH_API}/contents/${dirPath}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" },
    cache: "no-store",
  });
  if (res.status === 404) return [];
  if (!res.ok) return [];
  return res.json() as Promise<GHTreeItem[]>;
}

// Recursively delete all files in a directory (2 levels deep)
async function ghDeleteDir(dirPath: string, commitMsg: string): Promise<{ deleted: string[]; errors: string[] }> {
  const deleted: string[] = [];
  const errors: string[] = [];

  const entries = await ghListDir(dirPath);
  for (const entry of entries) {
    if (entry.type === "file" && entry.sha) {
      const ok = await ghDeleteFile(entry.path, commitMsg, entry.sha);
      if (ok) deleted.push(entry.path);
      else errors.push(`Failed to delete ${entry.path}`);
    } else if (entry.type === "dir") {
      const sub = await ghDeleteDir(entry.path, commitMsg);
      deleted.push(...sub.deleted);
      errors.push(...sub.errors);
    }
  }
  return { deleted, errors };
}

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

    // 1. Remove bootstrap files for this slug
    for (const bsFile of [
      `kubernetes/bootstrap/catalog-${slug}.yaml`,
      `kubernetes/bootstrap/catalog-${slug}-manifests.yaml`,
      `kubernetes/bootstrap/catalog-${slug}-secrets.yaml`,
    ]) {
      const sha = await ghGetFileSha(bsFile);
      if (sha) {
        const ok = await ghDeleteFile(bsFile, `chore(apps): uninstall ${slug}`, sha);
        if (ok) deleted.push(bsFile);
        else errors.push(`Failed to delete ${bsFile}`);
      }
    }

    // 2. Remove catalog directory
    const catalogDir = `kubernetes/catalog/${slug}`;
    const dirResult = await ghDeleteDir(catalogDir, `chore(apps): remove ${slug} catalog files`);
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
    const dirResult = await ghDeleteDir(platformDir, `chore(platform): remove ${appName}`);
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
