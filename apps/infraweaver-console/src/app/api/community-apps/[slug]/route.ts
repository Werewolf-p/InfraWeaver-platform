/**
 * DELETE /api/community-apps/[slug]
 *
 * Uninstalls a community app by removing its bootstrap ArgoCD Application file
 * and catalog directory from the GitHub repository. ArgoCD will remove the
 * deployed resources once it detects the Application is gone.
 */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";
const GH_API = `https://api.github.com/repos/${GITHUB_REPO}`;

interface GHFileContent {
  sha: string;
  content: string;
  encoding: string;
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

function slugIsValid(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug) && slug.length > 0 && slug.length < 64;
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  if (!slugIsValid(slug)) {
    return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
  }

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "apps:write")) {
    return NextResponse.json({ error: "Forbidden — requires apps:write" }, { status: 403 });
  }

  const errors: string[] = [];
  const deleted: string[] = [];

  // 1. Delete the bootstrap ArgoCD Application file
  const bootstrapPath = `kubernetes/bootstrap/catalog-${slug}-manifests.yaml`;
  const bootstrapSha = await ghGetFileSha(bootstrapPath);
  if (bootstrapSha) {
    const ok = await ghDeleteFile(
      bootstrapPath,
      `chore(apps): uninstall community app ${slug}`,
      bootstrapSha
    );
    if (ok) deleted.push(bootstrapPath);
    else errors.push(`Failed to delete ${bootstrapPath}`);
  }

  // 2. Delete all files in kubernetes/catalog/<slug>/
  const catalogDir = `kubernetes/catalog/${slug}`;
  const entries = await ghListDir(catalogDir);

  // Delete each file individually (GitHub API doesn't support directory delete)
  for (const entry of entries) {
    if (entry.type === "file" && entry.sha) {
      const ok = await ghDeleteFile(
        entry.path,
        `chore(apps): remove ${slug} catalog files`,
        entry.sha
      );
      if (ok) deleted.push(entry.path);
      else errors.push(`Failed to delete ${entry.path}`);
    }
    // Recurse one level for manifests subdirectory
    if (entry.type === "dir") {
      const subEntries = await ghListDir(entry.path);
      for (const sub of subEntries) {
        if (sub.type === "file" && sub.sha) {
          const ok = await ghDeleteFile(
            sub.path,
            `chore(apps): remove ${slug} catalog files`,
            sub.sha
          );
          if (ok) deleted.push(sub.path);
          else errors.push(`Failed to delete ${sub.path}`);
        }
      }
    }
  }

  if (errors.length > 0 && deleted.length === 0) {
    return NextResponse.json({ error: "Uninstall failed", details: errors }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    message: `${slug} scheduled for removal. ArgoCD will clean up deployed resources shortly.`,
    deleted,
    errors: errors.length > 0 ? errors : undefined,
  });
}
