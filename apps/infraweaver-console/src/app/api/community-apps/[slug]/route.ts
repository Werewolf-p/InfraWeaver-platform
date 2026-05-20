/**
 * GET  /api/community-apps/[slug]  — fetch app metadata from AppFeed
 * DELETE /api/community-apps/[slug] — uninstall: K8s cleanup via API, then git file removal
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { summarizeApp, type AppFeedConfig, type AppFeedEntry } from "@/lib/appfeed-converter";
import { getAppFeed } from "@/lib/appfeed-cache";
import { getRequestClusterId } from "@/lib/cluster-context";
import { gitCommitFiles, gitDeleteDir } from "@/lib/git-provider";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";
import { iwApiFetch } from "@/lib/iw-api";

function slugIsValid(slug: string): boolean {
  return /^[a-z0-9-]+$/.test(slug) && slug.length > 0 && slug.length < 64;
}

function getAppConfigs(app: AppFeedEntry): AppFeedConfig[] {
  if (!app.Config) return [];
  return Array.isArray(app.Config) ? app.Config : [app.Config];
}


export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  if (!slugIsValid(slug)) return NextResponse.json({ error: "Invalid slug" }, { status: 400 });

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "apps:read")) {
    return NextResponse.json({ error: "Forbidden — requires apps:read" }, { status: 403 });
  }

  try {
    const feed = await getAppFeed();
    const app = (feed.applist ?? []).find((entry): entry is AppFeedEntry => {
      const candidate = entry as AppFeedEntry;
      return typeof candidate.Name === "string"
        && typeof candidate.Repository === "string"
        && summarizeApp(candidate).slug === slug;
    });

    if (!app) return NextResponse.json({ error: "App not found" }, { status: 404 });

    const summary = summarizeApp(app);
    return NextResponse.json({
      ...summary,
      repository: app.Repository,
      registry: app.Registry,
      project: app.Project,
      templateUrl: app.TemplateURL,
      network: app.Network,
      shell: app.Shell,
      privileged: String(app.Privileged ?? "").toLowerCase() === "true",
      extraParams: app.ExtraParams,
      postArgs: app.PostArgs,
      requires: app.Requires,
      configs: getAppConfigs(app).map((config) => {
        const attrs = config["@attributes"];
        return {
          name: attrs.Name,
          target: attrs.Target,
          type: attrs.Type,
          defaultValue: attrs.Default,
          description: attrs.Description,
          display: attrs.Display,
          mode: attrs.Mode,
          required: attrs.Required === "true",
          masked: attrs.Mask === "true",
        };
      }),
    });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 502 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  if (!slugIsValid(slug)) return NextResponse.json({ error: "Invalid slug" }, { status: 400 });

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "apps:write")) {
    return NextResponse.json({ error: "Forbidden — requires apps:write" }, { status: 403 });
  }
  if (!checkRateLimit(rateLimitKey("community-apps-delete", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const errors: string[] = [];
  const deleted: string[] = [];
  const clusterId = getRequestClusterId(req);

  // 1. K8s cleanup: remove finalizer, delete namespace, delete ArgoCD app
  const k8sRes = await iwApiFetch(`/community-apps/${slug}`, session, clusterId, { method: "DELETE" });
  if (!k8sRes.ok) {
    const body = await k8sRes.json().catch(() => ({})) as { error?: string };
    errors.push(body.error ?? "K8s cleanup failed");
  }

  // 2. Delete the bootstrap file + entire catalog dir in two batched git operations
  const bootstrapPath = `kubernetes/bootstrap/catalog-${slug}-manifests.yaml`;
  try {
    await gitCommitFiles({ message: `chore(apps): uninstall community app ${slug}`, deleteFiles: [bootstrapPath] });
    deleted.push(bootstrapPath);
  } catch {
    errors.push(`Failed to delete ${bootstrapPath}`);
  }

  // 3. Delete all files in kubernetes/catalog/<slug>/ — single clone for Onedev
  const catalogDir = `kubernetes/catalog/${slug}`;
  const dirResult = await gitDeleteDir(catalogDir, `chore(apps): remove ${slug} catalog files`);
  deleted.push(...dirResult.deleted);
  errors.push(...dirResult.errors);

  if (errors.length > 0 && deleted.length === 0) {
    return NextResponse.json({ error: "Uninstall failed", details: errors }, { status: 500 });
  }

  // 4. Trigger bootstrap hard-refresh so it picks up the git changes
  void iwApiFetch("/community-apps/bootstrap-refresh", session, clusterId, { method: "POST", body: "{}" });

  return NextResponse.json({
    success: true,
    message: `${slug} uninstalled. Resources and git files removed.`,
    deleted,
    errors: errors.length > 0 ? errors : undefined,
  });
}
