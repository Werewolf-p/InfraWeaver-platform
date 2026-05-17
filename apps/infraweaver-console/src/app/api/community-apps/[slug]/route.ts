/**
 * DELETE /api/community-apps/[slug]
 *
 * Uninstalls a community app by removing its bootstrap ArgoCD Application file
 * and catalog directory from the GitHub repository. ArgoCD will remove the
 * deployed resources once it detects the Application is gone.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { summarizeApp, type AppFeedConfig, type AppFeedEntry } from "@/lib/appfeed-converter";
import { getAppFeed } from "@/lib/appfeed-cache";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";
import { loadKubeConfig } from "@/lib/k8s";
import {
  createConfiguration,
  ServerConfiguration,
  type RequestContext,
  type ResponseContext,
} from "@kubernetes/client-node";
import * as k8s from "@kubernetes/client-node";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "Werewolf-p/InfraWeaver-platform";
const GH_API = `https://api.github.com/repos/${GITHUB_REPO}`;

/** Creates a CustomObjectsApi client that sends application/merge-patch+json on PATCH. */
function makeArgoCustomApi() {
  const kc = loadKubeConfig();
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error("No active cluster");
  const mergePatchMiddleware = {
    pre: async (ctx: RequestContext): Promise<RequestContext> => {
      if (ctx.getHttpMethod() === "PATCH") {
        ctx.setHeaderParam("Content-Type", "application/merge-patch+json");
      }
      return ctx;
    },
    post: async (rsp: ResponseContext): Promise<ResponseContext> => rsp,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = createConfiguration({
    baseServer: new ServerConfiguration(cluster.server, {}),
    authMethods: { default: kc as any },
    promiseMiddleware: [mergePatchMiddleware],
  });
  return new k8s.CustomObjectsApi(cfg);
}

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

function getAppConfigs(app: AppFeedEntry): AppFeedConfig[] {
  if (!app.Config) return [];
  return Array.isArray(app.Config) ? app.Config : [app.Config];
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  if (!slugIsValid(slug)) {
    return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
  }

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

    if (!app) {
      return NextResponse.json({ error: "App not found" }, { status: 404 });
    }

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

async function cleanupArgoApplication(argoAppName: string, namespace: string): Promise<void> {
  const customApi = makeArgoCustomApi();
  const kc = loadKubeConfig();
  const cluster = kc.getCurrentCluster();

  // 1. Remove the finalizer so the ArgoCD app can be deleted instantly
  try {
    await customApi.patchNamespacedCustomObject({
      group: "argoproj.io",
      version: "v1alpha1",
      namespace: "argocd",
      plural: "applications",
      name: argoAppName,
      body: { metadata: { finalizers: [] } },
    });
  } catch {
    // 404 means app doesn't exist — fine
  }

  // 2. Delete the app namespace (cascade-deletes deployment, service, PVCs, etc.)
  if (cluster) {
    try {
      const cfg = createConfiguration({
        baseServer: new ServerConfiguration(cluster.server, {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        authMethods: { default: kc as any },
      });
      const coreApi = new k8s.CoreV1Api(cfg);
      await coreApi.deleteNamespace({ name: namespace });
    } catch {
      // 404 = already gone; other errors are non-fatal (bootstrap will prune)
    }
  }

  // 3. Delete the ArgoCD Application resource (no finalizer → instant)
  try {
    await customApi.deleteNamespacedCustomObject({
      group: "argoproj.io",
      version: "v1alpha1",
      namespace: "argocd",
      plural: "applications",
      name: argoAppName,
    });
  } catch {
    // Ignore 404 / already deleted
  }
}

/** Annotate the bootstrap ArgoCD app to force an immediate hard refresh so it
 *  picks up git changes (prune of removed files) without waiting for the poll. */
async function triggerBootstrapRefresh(): Promise<void> {
  try {
    const kc = loadKubeConfig();
    const cluster = kc.getCurrentCluster();
    if (!cluster) return;
    const mergePatchMiddleware = {
      pre: async (ctx: RequestContext): Promise<RequestContext> => {
        if (ctx.getHttpMethod() === "PATCH") {
          ctx.setHeaderParam("Content-Type", "application/merge-patch+json");
        }
        return ctx;
      },
      post: async (rsp: ResponseContext): Promise<ResponseContext> => rsp,
    };
    const cfg = createConfiguration({
      baseServer: new ServerConfiguration(cluster.server, {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      authMethods: { default: kc as any },
      promiseMiddleware: [mergePatchMiddleware],
    });
    const customApi = new k8s.CustomObjectsApi(cfg);
    await customApi.patchNamespacedCustomObject({
      group: "argoproj.io",
      version: "v1alpha1",
      namespace: "argocd",
      plural: "applications",
      name: "bootstrap",
      body: { metadata: { annotations: { "argocd.argoproj.io/refresh": "hard" } } },
    });
  } catch {
    // Non-fatal — bootstrap will pick up changes on next poll
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;

  if (!slugIsValid(slug)) {
    return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
  }

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

  // 1. Remove ArgoCD finalizer + delete namespace (cascade resources) + delete ArgoCD app.
  //    Deleting namespace first ensures clean resource removal before git files disappear.
  //    Deleting the ArgoCD app ensures bootstrap's next prune finds nothing to do (no 404
  //    failure that exhausts bootstrap's retry counter and causes Degraded state).
  try {
    await cleanupArgoApplication(`catalog-${slug}-manifests`, slug);
  } catch (error) {
    errors.push(safeError(error));
  }

  // 2. Delete the bootstrap ArgoCD Application file
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

  // 3. Delete all files in kubernetes/catalog/<slug>/
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

  // Trigger bootstrap hard-refresh so it updates its resource tracking.
  // Since we already deleted the ArgoCD app above, bootstrap's prune finds
  // nothing to do — no 404 failure that would exhaust its retry counter.
  void triggerBootstrapRefresh();

  return NextResponse.json({
    success: true,
    message: `${slug} uninstalled. Resources and git files removed.`,
    deleted,
    errors: errors.length > 0 ? errors : undefined,
  });
}
