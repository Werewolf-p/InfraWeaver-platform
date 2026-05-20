/**
 * POST /api/community-apps/deploy
 *
 * Commits a converted AppFeed app to git and creates the ArgoCD Application
 * via infraweaver-api (which handles all K8s operations).
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { auditLog } from "@/lib/audit-log";
import { convertAppFeedEntry, reconcileAppPortsWithImageMetadata } from "@/lib/appfeed-converter";
import { findAppByIdentifier } from "@/lib/appfeed-cache";
import { getRequestClusterId } from "@/lib/cluster-context";
import { gitCommitFiles, getGitRepoUrl } from "@/lib/git-provider";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";
import { iwApiFetch } from "@/lib/iw-api";
import { z } from "zod";

const DeployBody = z.object({
  appName: z.string().min(1).max(200).optional(),
  slug: z.string().min(1).max(200).optional(),
  namespace: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/).optional(),
  pvcSizeGi: z.number().int().min(1).max(10000).optional(),
  storageClass: z.string().max(63).optional(),
  ingressHost: z.string().max(253).optional(),
  createIngress: z.boolean().optional(),
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
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { appName, slug: requestedSlug, namespace, pvcSizeGi, storageClass, ingressHost, createIngress, userVariables } = parsed.data;
  const appIdentifier = appName?.trim() || requestedSlug?.trim() || "";
  const clusterId = getRequestClusterId(req);

  const app = await findAppByIdentifier(appIdentifier);
  if (!app) return NextResponse.json({ error: `App "${appIdentifier}" not found in AppFeed` }, { status: 404 });

  const slug = sanitizeKubernetesName(app.Name);
  const ns = sanitizeKubernetesName(namespace ?? slug);

  // Check if a non-community ArgoCD app already exists for this slug
  const existsRes = await iwApiFetch(`/community-apps/${slug}`, session, clusterId);
  if (existsRes.ok) {
    const existing = await existsRes.json() as { exists?: boolean; isCommunityApp?: boolean };
    if (existing.exists && !existing.isCommunityApp) {
      return NextResponse.json({
        error: `"${app.Name}" is already installed as a platform-managed application. To reinstall, remove it from the platform catalog first.`,
        conflict: true,
      }, { status: 409 });
    }
  }

  let result: ReturnType<typeof convertAppFeedEntry>;
  try {
    const normalizedApp = await reconcileAppPortsWithImageMetadata(app);
    result = convertAppFeedEntry(normalizedApp, {
      namespace: ns,
      pvcSizeGi,
      storageClass: storageClass?.trim() || undefined,
      ingressHost: ingressHost?.trim() || undefined,
      ingressDomain: process.env.BASE_DOMAIN,
      createIngress,
      userVariables,
    });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 422 });
  }

  const baseDir = `kubernetes/catalog/${slug}/manifests`;
  const appDescription = (app.Overview ?? "").replace(/\s+/g, " ").trim().slice(0, 200).replace(/"/g, "'");
  const repoUrl = await getGitRepoUrl();

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
${(app.CategoryList ?? []).map((c) => `  - "${c}"`).join("\n")}
${result.manifests.ingressroute ? `ingressroute:\n  host: ${ingressHost ?? `${slug}.int.${process.env.BASE_DOMAIN ?? "local"}`}` : ""}
installed_at: ${new Date().toISOString()}
`;

  const allFiles: Array<[string, string]> = [];
  if (result.manifests.namespace) allFiles.push([`${baseDir}/namespace.yaml`, result.manifests.namespace]);
  allFiles.push([`${baseDir}/deployment.yaml`, deploymentWithService]);
  if (result.manifests.pvcs.length > 0) allFiles.push([`${baseDir}/pvc.yaml`, result.manifests.pvcs.join("\n")]);
  if (result.manifests.ingressroute) allFiles.push([`${baseDir}/ingressroute.yaml`, result.manifests.ingressroute]);
  if (result.manifests.secrets) allFiles.push([`${baseDir}/secrets.yaml`, result.manifests.secrets]);
  allFiles.push([`kubernetes/catalog/${slug}/catalog.yaml`, catalogYaml]);
  allFiles.push([`kubernetes/bootstrap/catalog-${slug}-manifests.yaml`, argoAppYaml]);

  try {
    await gitCommitFiles({
      message: `feat(community-apps): install ${slug} from AppFeed`,
      addOrUpdateFiles: allFiles.map(([path, content]) => ({ path, content })),
    });

    // Trigger bootstrap refresh and create the ArgoCD Application (polls for resolution)
    await Promise.all([
      iwApiFetch("/community-apps/bootstrap-refresh", session, clusterId, { method: "POST", body: "{}" }),
      iwApiFetch(`/community-apps/${slug}/argocd-app`, session, clusterId, {
        method: "POST",
        body: JSON.stringify({ repoUrl, baseDir, namespace: ns }),
      }),
    ]);

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
