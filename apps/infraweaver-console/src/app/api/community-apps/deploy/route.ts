/**
 * POST /api/community-apps/deploy
 *
 * Commits a converted AppFeed app to the platform Git repository so ArgoCD
 * picks it up and deploys it to the cluster.
 *
 * Files committed:
 *   kubernetes/catalog/<slug>/manifests/deployment.yaml  ← Deployment + (Service if ports)
 *   kubernetes/catalog/<slug>/manifests/pvc.yaml         ← PVCs (if Path configs present)
 *   kubernetes/catalog/<slug>/manifests/ingressroute.yaml ← Traefik route (if WebUI/ports)
 *   kubernetes/catalog/<slug>/catalog.yaml               ← catalog metadata
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { convertAppFeedEntry, reconcileAppPortsWithImageMetadata } from "@/lib/appfeed-converter";
import { findAppByIdentifier } from "@/lib/appfeed-cache";
import { getRequestClusterId } from "@/lib/cluster-context";
import { gitCommitFiles, getGitRepoUrl } from "@/lib/git-provider";
import { loadKubeConfig } from "@/lib/k8s";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";
import { z } from "zod";
import {
  createConfiguration,
  ServerConfiguration,
  type RequestContext,
  type ResponseContext,
} from "@kubernetes/client-node";
import * as k8s from "@kubernetes/client-node";

const APP_SOURCE_RESOLUTION_ATTEMPTS = 6;
const APP_SOURCE_RESOLUTION_DELAY_MS = 5000;

const mergePatchMiddleware = {
  pre: async (ctx: RequestContext): Promise<RequestContext> => {
    if (ctx.getHttpMethod() === "PATCH") {
      ctx.setHeaderParam("Content-Type", "application/merge-patch+json");
    }
    return ctx;
  },
  post: async (rsp: ResponseContext): Promise<ResponseContext> => rsp,
};

function createCustomObjectsApi(useMergePatch = false, clusterId?: string): k8s.CustomObjectsApi | null {
  const kc = loadKubeConfig(clusterId);
  const cluster = kc.getCurrentCluster();
  if (!cluster) return null;
  const cfg = createConfiguration({
    baseServer: new ServerConfiguration(cluster.server, {}),
    authMethods: { default: kc },
    promiseMiddleware: useMergePatch ? [mergePatchMiddleware] : [],
  });
  return new k8s.CustomObjectsApi(cfg);
}

/** Annotate the bootstrap ArgoCD app to force an immediate refresh so it picks
 *  up newly committed bootstrap files without waiting for the 3-minute poll. */
async function triggerBootstrapRefresh(clusterId?: string): Promise<void> {
  try {
    const customApi = createCustomObjectsApi(true, clusterId);
    if (!customApi) return;
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

async function triggerCatalogAppRefresh(name: string, clusterId?: string): Promise<void> {
  const customApi = createCustomObjectsApi(true, clusterId);
  if (!customApi) return;
  await customApi.patchNamespacedCustomObject({
    group: "argoproj.io",
    version: "v1alpha1",
    namespace: "argocd",
    plural: "applications",
    name,
    body: { metadata: { annotations: { "argocd.argoproj.io/refresh": "hard" } } },
  });
}

async function waitForCatalogAppSourceResolution(name: string, clusterId?: string): Promise<void> {
  const customApi = createCustomObjectsApi(undefined, clusterId);
  if (!customApi) return;

  for (let attempt = 0; attempt < APP_SOURCE_RESOLUTION_ATTEMPTS; attempt++) {
    try {
      await triggerCatalogAppRefresh(name, clusterId);
    } catch {
      // Application may not be visible yet; fall through to the next poll.
    }

    await new Promise((resolve) => setTimeout(resolve, APP_SOURCE_RESOLUTION_DELAY_MS));

    try {
      const application = await customApi.getNamespacedCustomObject({
        group: "argoproj.io",
        version: "v1alpha1",
        namespace: "argocd",
        plural: "applications",
        name,
      }) as {
        status?: {
          conditions?: Array<{ type?: string; message?: string }>;
        };
      };
      const comparisonError = application.status?.conditions?.find((condition) => condition.type === "ComparisonError");
      if (!comparisonError) return;
      if (!/app path does not exist/i.test(comparisonError.message ?? "")) return;
    } catch {
      // Keep retrying — Argo may still be creating or refreshing the app.
    }
  }
}

const DeployBody = z.object({
  appName: z.string().min(1).max(200).optional(),
  slug: z.string().min(1).max(200).optional(),
  namespace: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/).optional(),
  pvcSizeGi: z.number().int().min(1).max(10000).optional(),
  storageClass: z.string().max(63).optional(),
  ingressHost: z.string().max(253).optional(),
  createIngress: z.boolean().optional(),
  /** User-supplied values for Required/placeholder variables, keyed by env var name */
  userVariables: z.record(z.string(), z.string().max(4096)).optional(),
}).refine((value) => Boolean(value.appName?.trim() || value.slug?.trim()), {
  message: "appName or slug is required",
  path: ["appName"],
});

function sanitizeKubernetesName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "") || "app";
}

async function findAppInFeed(identifier: string) {
  return findAppByIdentifier(identifier);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "catalog:write")) {
    return NextResponse.json({ error: "Forbidden: catalog:write permission required" }, { status: 403 });
  }

  if (!checkRateLimit(rateLimitKey("community-deploy", req), 5, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const parsed = DeployBody.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { appName, slug: requestedSlug, namespace, pvcSizeGi, storageClass, ingressHost, createIngress, userVariables } = parsed.data;
  const appIdentifier = appName?.trim() || requestedSlug?.trim() || "";
  const clusterId = getRequestClusterId(req);

  const app = await findAppInFeed(appIdentifier);
  if (!app) {
    return NextResponse.json({ error: `App "${appIdentifier}" not found in AppFeed` }, { status: 404 });
  }

  const slug = sanitizeKubernetesName(app.Name);
  const ns = sanitizeKubernetesName(namespace ?? slug);

  // Check if an ArgoCD Application already exists for this slug that was NOT
  // installed by the community-apps flow (i.e. a platform-managed app).
  // Deploying on top of a platform app causes namespace conflicts.
  try {
    const customApi = createCustomObjectsApi(false, clusterId);
    if (customApi) {
      const existing = await customApi.getNamespacedCustomObject({
        group: "argoproj.io",
        version: "v1alpha1",
        namespace: "argocd",
        plural: "applications",
        name: `catalog-${slug}-manifests`,
      }).catch(() => null);
      if (existing) {
        const existingApp = existing as { metadata?: { labels?: Record<string, string> } };
        const labels = existingApp.metadata?.labels ?? {};
        const isCommunityApp = labels["infraweaver.io/source"] === "community-apps";
        if (!isCommunityApp) {
          return NextResponse.json({
            error: `"${app.Name}" is already installed as a platform-managed application. To reinstall, remove it from the platform catalog first.`,
            conflict: true,
          }, { status: 409 });
        }
        // It's a prior community-apps install — allow update/redeploy.
      }
    }
  } catch {
    // Non-fatal check — proceed with deploy if we can't verify
  }

  let result: ReturnType<typeof convertAppFeedEntry>;
  try {
    const normalizedApp = await reconcileAppPortsWithImageMetadata(app);
    result = convertAppFeedEntry(normalizedApp, {
      namespace: ns,
      pvcSizeGi,
      storageClass: storageClass?.trim() || undefined,
      ingressHost: ingressHost?.trim() || undefined,
      createIngress,
      userVariables,
    });
  } catch (error) {
    return NextResponse.json(
      { error: safeError(error) },
      { status: 422 }
    );
  }

  const baseDir = `kubernetes/catalog/${slug}/manifests`;
  const appDescription = (app.Overview ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
    .replace(/"/g, "'");

  const repoUrl = await getGitRepoUrl();

  // ArgoCD Application manifest (same pattern as catalog-*-manifests.yaml in bootstrap/)
  const argoAppYaml = `---
# catalog-${slug}-manifests.yaml — deployed by InfraWeaver Community Apps
# Source: ${app.Repository}
# Installed: ${new Date().toISOString()}
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: catalog-${slug}-manifests
  namespace: argocd
  labels:
    infraweaver.io/type: catalog-app
    infraweaver.io/source: community-apps
  finalizers:
    - resources-finalizer.argocd.argoproj.io
spec:
  project: platform
  source:
    repoURL: ${repoUrl}
    targetRevision: HEAD
    path: ${baseDir}
  destination:
    server: https://kubernetes.default.svc
    namespace: ${ns}
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
    syncOptions:
      - CreateNamespace=true
      - ServerSideApply=true
`;

  // Combine deployment + service into one file
  const deploymentWithService = result.manifests.service
    ? result.manifests.deployment + "\n" + result.manifests.service
    : result.manifests.deployment;

  const catalogYaml = `# Community app installed from Unraid AppFeed
# Source: ${app.Repository}
name: ${slug}
description: "${appDescription}"
namespace: ${ns}
source: community-apps
tier: ${result.tier}
image: ${app.Repository}
categories:
${(app.CategoryList ?? []).map(c => `  - "${c}"`).join("\n")}
${result.manifests.ingressroute ? `ingressroute:\n  host: ${ingressHost ?? `${slug}.int.rlservers.com`}` : ""}
installed_at: ${new Date().toISOString()}
`;

  const allFiles: Array<[string, string]> = [];
  // namespace.yaml must come first — it sets pod-security labels before deployment
  if (result.manifests.namespace) {
    allFiles.push([`${baseDir}/namespace.yaml`, result.manifests.namespace]);
  }
  allFiles.push([`${baseDir}/deployment.yaml`, deploymentWithService]);
  if (result.manifests.pvcs.length > 0) {
    allFiles.push([`${baseDir}/pvc.yaml`, result.manifests.pvcs.join("\n")]);
  }
  if (result.manifests.ingressroute) {
    allFiles.push([`${baseDir}/ingressroute.yaml`, result.manifests.ingressroute]);
  }
  if (result.manifests.secrets) {
    allFiles.push([`${baseDir}/secrets.yaml`, result.manifests.secrets]);
  }
  allFiles.push([`kubernetes/catalog/${slug}/catalog.yaml`, catalogYaml]);
  allFiles.push([`kubernetes/bootstrap/catalog-${slug}-manifests.yaml`, argoAppYaml]);

  try {
    await gitCommitFiles({
      message: `feat(community-apps): install ${slug} from AppFeed`,
      addOrUpdateFiles: allFiles.map(([path, content]) => ({ path, content })),
    });

    // Kick bootstrap to immediately pick up the new ArgoCD Application file
    // instead of waiting up to 3 minutes for the auto-poll interval.
    await triggerBootstrapRefresh(clusterId);

    // Also directly apply the ArgoCD Application resource so the app starts
    // deploying immediately even if bootstrap is mid-sync on other apps.
    try {
      const customApi = createCustomObjectsApi(false, clusterId);
      if (customApi) {
        const argoApp = {
          apiVersion: "argoproj.io/v1alpha1",
          kind: "Application",
          metadata: {
            name: `catalog-${slug}-manifests`,
            namespace: "argocd",
            labels: {
              "infraweaver.io/type": "catalog-app",
              "infraweaver.io/source": "community-apps",
            },
            finalizers: ["resources-finalizer.argocd.argoproj.io"],
          },
          spec: {
            project: "platform",
            source: {
              repoURL: repoUrl,
              targetRevision: "HEAD",
              path: baseDir,
            },
            destination: {
              server: "https://kubernetes.default.svc",
              namespace: ns,
            },
            syncPolicy: {
              automated: { prune: true, selfHeal: true },
              retry: { limit: 5, backoff: { duration: "5s", factor: 2, maxDuration: "3m" } },
              syncOptions: ["CreateNamespace=true", "ServerSideApply=true"],
            },
          },
        };
        await customApi.createNamespacedCustomObject({
          group: "argoproj.io",
          version: "v1alpha1",
          namespace: "argocd",
          plural: "applications",
          body: argoApp,
        }).catch(() => undefined);
        await waitForCatalogAppSourceResolution(`catalog-${slug}-manifests`, clusterId);
      }
    } catch {
      // Non-fatal — if the refresh wait fails, bootstrap/self-heal will reconcile later
    }

    await auditLog(
      "community-apps:deploy",
      session.user?.email ?? "unknown",
      `Deployed ${app.Name} (${app.Repository}) → kubernetes/catalog/${slug}/`
    );

    return NextResponse.json({
      ok: true,
      slug,
      namespace: ns,
      tier: result.tier,
      warnings: result.warnings,
      paths: allFiles.map(([p]) => p),
      argocdNote: `ArgoCD will auto-sync this app once the files are committed. If not, run: argocd app sync catalog-${slug}-manifests`,
    });
  } catch (err) {
    return NextResponse.json({ error: safeError(err) }, { status: 500 });
  }
}
