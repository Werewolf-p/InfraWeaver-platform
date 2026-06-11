import { Hono } from 'hono';
import { z } from 'zod';
import * as k8s from '@kubernetes/client-node';
import { getCoreApiForCluster, getCustomApiForCluster, getKcForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
import type { AppBindings } from '../types/index.js';

const APP_SOURCE_RESOLUTION_ATTEMPTS = 6;
const APP_SOURCE_RESOLUTION_DELAY_MS = 5000;

const argoAppBodySchema = z.object({
  repoUrl: z.string().url(),
  baseDir: z.string().min(1).max(500),
  namespace: z.string().min(1).max(63),
});

const k8sNameRe = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const k8sNamespaceRe = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$|^[a-z0-9]$/;

// C6: community-app secrets are created directly via the K8s API (NOT committed
// to git). Values never touch the repo, so they cannot leak through git history.
const secretsBodySchema = z.object({
  namespace: z.string().min(1).max(63).regex(k8sNamespaceRe, 'Invalid namespace'),
  secrets: z.array(z.object({
    name: z.string().min(1).max(253).regex(k8sNameRe, 'Invalid secret name'),
    stringData: z.record(z.string().min(1).max(253), z.string().max(64 * 1024)),
  })).min(1).max(50),
});

const slugRe = /^[a-z0-9-]+$/;

function k8sStatusCode(e: unknown): number | undefined {
  return (e as { statusCode?: number })?.statusCode
    ?? (e as { response?: { statusCode?: number } })?.response?.statusCode
    ?? (e as { code?: number })?.code;
}

async function getMergePatchCustomApi(clusterId: string): Promise<k8s.CustomObjectsApi> {
  const kc = await getKcForCluster(clusterId);
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error('No active cluster');
  const mergePatchMiddleware = {
    pre: async (ctx: k8s.RequestContext): Promise<k8s.RequestContext> => {
      if (ctx.getHttpMethod() === 'PATCH') ctx.setHeaderParam('Content-Type', 'application/merge-patch+json');
      return ctx;
    },
    post: async (rsp: k8s.ResponseContext): Promise<k8s.ResponseContext> => rsp,
  };
  const cfg = k8s.createConfiguration({
    baseServer: new k8s.ServerConfiguration(cluster.server, {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authMethods: { default: kc as any },
    promiseMiddleware: [mergePatchMiddleware],
  });
  return new k8s.CustomObjectsApi(cfg);
}

async function triggerBootstrapRefresh(clusterId: string): Promise<void> {
  try {
    const customApi = await getMergePatchCustomApi(clusterId);
    await customApi.patchNamespacedCustomObject({
      group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd', plural: 'applications', name: 'bootstrap',
      body: { metadata: { annotations: { 'argocd.argoproj.io/refresh': 'hard' } } },
    });
  } catch { /* non-fatal */ }
}

export const communityAppsRoute = new Hono<AppBindings>();

communityAppsRoute.get('/:slug', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'apps:read')) return c.json({ error: 'Forbidden' }, 403);
  const { slug } = c.req.param();
  if (!slugRe.test(slug)) return c.json({ error: 'Invalid slug' }, 400);
  try {
    const customApi = await getCustomApiForCluster(user.clusterId);
    const existing = await customApi.getNamespacedCustomObject({
      group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd', plural: 'applications',
      name: `catalog-${slug}-manifests`,
    }).catch(() => null);
    if (!existing) return c.json({ exists: false });
    const app = existing as { metadata?: { labels?: Record<string, string> } };
    return c.json({ exists: true, isCommunityApp: app.metadata?.labels?.['infraweaver.io/source'] === 'community-apps' });
  } catch {
    return c.json({ exists: false });
  }
});

communityAppsRoute.delete('/:slug', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'catalog:delete')) return c.json({ error: 'Forbidden' }, 403);
  const { slug } = c.req.param();
  if (!slugRe.test(slug)) return c.json({ error: 'Invalid slug' }, 400);

  const argoAppName = `catalog-${slug}-manifests`;
  try {
    const [customApi, coreApi] = await Promise.all([
      getMergePatchCustomApi(user.clusterId),
      getCoreApiForCluster(user.clusterId),
    ]);

    // 1. Remove finalizer so the app can be deleted instantly
    await customApi.patchNamespacedCustomObject({
      group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd', plural: 'applications',
      name: argoAppName, body: { metadata: { finalizers: [] } },
    }).catch(() => { /* 404 is fine */ });

    // 2. Delete namespace (cascade-deletes deployments, pvcs, etc.)
    await coreApi.deleteNamespace({ name: slug }).catch(() => { /* 404 is fine */ });

    // 3. Delete the ArgoCD Application resource
    await customApi.deleteNamespacedCustomObject({
      group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd', plural: 'applications',
      name: argoAppName,
    }).catch(() => { /* 404 is fine */ });

    return c.json({ ok: true });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : 'K8s cleanup failed' }, 502);
  }
});

communityAppsRoute.post('/bootstrap-refresh', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'apps:write')) return c.json({ error: 'Forbidden' }, 403);
  await triggerBootstrapRefresh(user.clusterId);
  return c.json({ ok: true });
});

communityAppsRoute.post('/:slug/argocd-app', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'catalog:write')) return c.json({ error: 'Forbidden' }, 403);
  const { slug } = c.req.param();
  if (!slugRe.test(slug)) return c.json({ error: 'Invalid slug' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = argoAppBodySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { repoUrl, baseDir, namespace } = parsed.data;

  const argoAppName = `catalog-${slug}-manifests`;
  try {
    const customApi = await getCustomApiForCluster(user.clusterId);
    await customApi.createNamespacedCustomObject({
      group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd', plural: 'applications',
      body: {
        apiVersion: 'argoproj.io/v1alpha1',
        kind: 'Application',
        metadata: { name: argoAppName, namespace: 'argocd', labels: { 'infraweaver.io/type': 'catalog-app', 'infraweaver.io/source': 'community-apps' }, finalizers: ['resources-finalizer.argocd.argoproj.io'] },
        spec: {
          project: 'platform',
          source: { repoURL: repoUrl, targetRevision: 'HEAD', path: baseDir },
          destination: { server: 'https://kubernetes.default.svc', namespace },
          syncPolicy: { automated: { prune: true, selfHeal: true }, retry: { limit: 5, backoff: { duration: '5s', factor: 2, maxDuration: '3m' } }, syncOptions: ['CreateNamespace=true', 'ServerSideApply=true'] },
        },
      },
    }).catch(() => { /* already exists — fine */ });

    // Poll until ArgoCD resolves the app source (max 30s)
    const mergePatchApi = await getMergePatchCustomApi(user.clusterId);
    for (let attempt = 0; attempt < APP_SOURCE_RESOLUTION_ATTEMPTS; attempt++) {
      await mergePatchApi.patchNamespacedCustomObject({
        group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd', plural: 'applications',
        name: argoAppName, body: { metadata: { annotations: { 'argocd.argoproj.io/refresh': 'hard' } } },
      }).catch(() => { /* app may not be visible yet */ });

      await new Promise((resolve) => setTimeout(resolve, APP_SOURCE_RESOLUTION_DELAY_MS));

      try {
        const application = await customApi.getNamespacedCustomObject({
          group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd', plural: 'applications', name: argoAppName,
        }) as { status?: { conditions?: Array<{ type?: string; message?: string }> } };
        const comparisonError = application.status?.conditions?.find((cond) => cond.type === 'ComparisonError');
        if (!comparisonError || !/app path does not exist/i.test(comparisonError.message ?? '')) break;
      } catch { /* keep retrying */ }
    }

    return c.json({ ok: true, argoAppName });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : 'Failed to create ArgoCD app' }, 502);
  }
});

// C6: create community-app secrets directly in the cluster instead of committing
// them to git. The secrets carry only our own labels (no argocd tracking label),
// so ArgoCD's prune/selfHeal will not adopt or delete them.
communityAppsRoute.post('/:slug/secrets', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'catalog:write')) return c.json({ error: 'Forbidden' }, 403);
  if (user.clusterId === 'all') return c.json({ error: 'Select a specific cluster before performing this action' }, 400);
  const { slug } = c.req.param();
  if (!slugRe.test(slug)) return c.json({ error: 'Invalid slug' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = secretsBodySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
  const { namespace, secrets } = parsed.data;

  try {
    const coreApi = await getCoreApiForCluster(user.clusterId);

    // Ensure the target namespace exists (ArgoCD also creates it via
    // CreateNamespace=true, but that sync is async — create eagerly so the
    // Secret has a home immediately).
    await coreApi.readNamespace({ name: namespace }).catch(async (err) => {
      if (k8sStatusCode(err) !== 404) throw err;
      await coreApi.createNamespace({ body: { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace } } })
        .catch((e) => { if (k8sStatusCode(e) !== 409) throw e; });
    });

    for (const s of secrets) {
      const secretBody = {
        apiVersion: 'v1' as const,
        kind: 'Secret' as const,
        type: 'Opaque' as const,
        metadata: {
          name: s.name,
          namespace,
          labels: { 'app.kubernetes.io/name': slug, 'infraweaver.io/source': 'community-apps' },
        },
        stringData: s.stringData,
      };
      try {
        await coreApi.createNamespacedSecret({ namespace, body: secretBody });
      } catch (e: unknown) {
        if (k8sStatusCode(e) !== 409) throw e;
        await coreApi.replaceNamespacedSecret({ name: s.name, namespace, body: secretBody });
      }
    }

    return c.json({ ok: true, count: secrets.length });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : 'Failed to create secrets' }, 502);
  }
});
