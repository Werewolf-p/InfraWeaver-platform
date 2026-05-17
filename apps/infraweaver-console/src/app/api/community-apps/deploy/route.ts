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
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { auditLog } from "@/lib/audit-log";
import { z } from "zod";
import { convertAppFeedEntry } from "@/lib/appfeed-converter";
import { findAppByName } from "@/lib/appfeed-cache";
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

/** Annotate the bootstrap ArgoCD app to force an immediate refresh so it picks
 *  up newly committed bootstrap files without waiting for the 3-minute poll. */
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = createConfiguration({
      baseServer: new ServerConfiguration(cluster.server, {}),
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

const DeployBody = z.object({
  appName: z.string().min(1).max(200),
  namespace: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/).optional(),
  pvcSizeGi: z.number().int().min(1).max(10000).optional(),
  storageClass: z.string().max(63).optional(),
  ingressHost: z.string().max(253).optional(),
  createIngress: z.boolean().optional(),
  /** User-supplied values for Required/placeholder variables, keyed by env var name */
  userVariables: z.record(z.string(), z.string().max(4096)).optional(),
});

interface GitHubFile {
  sha?: string;
}

/** Retry fetch on transient network errors (DNS failures, connection resets). */
async function fetchWithRetry(url: string, init?: RequestInit, retries = 3): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = /EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(msg);
      if (!isTransient || i >= retries - 1) throw err;
      await new Promise((r) => setTimeout(r, (i + 1) * 1000));
    }
  }
  throw lastError;
}

function sanitizeKubernetesName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "") || "app";
}

async function ghGet(path: string): Promise<GitHubFile | null> {
  const res = await fetchWithRetry(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
    },
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status}`);
  return res.json() as Promise<GitHubFile>;
}

async function ghPut(path: string, content: string, message: string, sha?: string): Promise<void> {
  const encoded = Buffer.from(content).toString("base64");
  const doRequest = async (fileSha?: string) => {
    const body: Record<string, unknown> = {
      message,
      content: encoded,
      committer: { name: "InfraWeaver Console", email: "console@rlservers.com" },
    };
    if (fileSha) body.sha = fileSha;
    return fetchWithRetry(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  };

  let res = await doRequest(sha);
  if (res.status === 409) {
    // SHA conflict: another concurrent request already committed this file.
    // Refresh the SHA and retry once.
    const fresh = await ghGet(path);
    res = await doRequest(fresh?.sha);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PUT ${path}: ${res.status} — ${text}`);
  }
}

async function findAppInFeed(name: string) {
  return findAppByName(name);
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
  const { appName, namespace, pvcSizeGi, storageClass, ingressHost, createIngress, userVariables } = parsed.data;

  const app = await findAppInFeed(appName);
  if (!app) {
    return NextResponse.json({ error: `App "${appName}" not found in AppFeed` }, { status: 404 });
  }

  const slug = sanitizeKubernetesName(app.Name);
  const ns = sanitizeKubernetesName(namespace ?? slug);

  // Check if an ArgoCD Application already exists for this slug that was NOT
  // installed by the community-apps flow (i.e. a platform-managed app).
  // Deploying on top of a platform app causes namespace conflicts.
  try {
    const kc = loadKubeConfig();
    const cluster = kc.getCurrentCluster();
    if (cluster) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cfg = createConfiguration({
        baseServer: new ServerConfiguration(cluster.server, {}),
        authMethods: { default: kc as any },
        promiseMiddleware: [],
      });
      const customApi = new k8s.CustomObjectsApi(cfg);
      const existing = await customApi.getNamespacedCustomObject({
        group: "argoproj.io",
        version: "v1alpha1",
        namespace: "argocd",
        plural: "applications",
        name: `catalog-${slug}-manifests`,
      }).catch(() => null);
      if (existing) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const labels = (existing as any)?.metadata?.labels ?? {};
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
    result = convertAppFeedEntry(app, {
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
    repoURL: https://github.com/${GITHUB_REPO}.git
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
    for (const [filePath, content] of allFiles) {
      const existing = await ghGet(filePath);
      await ghPut(
        filePath,
        content,
        `feat(community-apps): install ${slug} from AppFeed`,
        existing?.sha
      );
    }

    // Kick bootstrap to immediately pick up the new ArgoCD Application file
    // instead of waiting up to 3 minutes for the auto-poll interval.
    await triggerBootstrapRefresh();

    // Also directly apply the ArgoCD Application resource so the app starts
    // deploying immediately even if bootstrap is mid-sync on other apps.
    try {
      const kc = loadKubeConfig();
      const cluster = kc.getCurrentCluster();
      if (cluster) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cfg = createConfiguration({
          baseServer: new ServerConfiguration(cluster.server, {}),
          authMethods: { default: kc as any },
          promiseMiddleware: [],
        });
        const customApi = new k8s.CustomObjectsApi(cfg);
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
              repoURL: `https://github.com/${GITHUB_REPO}.git`,
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
        });
      }
    } catch {
      // Non-fatal — if it already exists or permission error, bootstrap will handle it
    }

    await auditLog(
      "community-apps:deploy",
      session.user?.email ?? "unknown",
      `Deployed ${appName} (${app.Repository}) → kubernetes/catalog/${slug}/`
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
