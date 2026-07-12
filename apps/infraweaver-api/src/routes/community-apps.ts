import { Hono } from 'hono';
import { z } from 'zod';
import * as k8s from '@kubernetes/client-node';
import { getCoreApiForCluster, getCustomApiForCluster, getKcForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
import { errMessage } from '../lib/errors.js';
import { forbidden, badRequest, invalidBody, notFound } from '../lib/responses.js';
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

// Core/system namespaces a community-app operation must never target — deleting
// or writing secrets into these would escape the community-apps scope entirely.
const RESERVED_NAMESPACES = new Set([
  'default', 'kube-system', 'kube-public', 'kube-node-lease', 'argocd',
  'cert-manager', 'external-secrets', 'external-dns', 'monitoring', 'falco',
  'longhorn-system', 'cilium-secrets', 'crds', 'bootstrap', 'dns-system',
  'infraweaver', 'infraweaver-console', 'infraweaver-system',
]);
const isReservedNamespace = (name: string): boolean =>
  RESERVED_NAMESPACES.has(name) || name.endsWith('-system') || name.startsWith('kube-');

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
  if (!hasPermission(user, 'apps:read')) return forbidden(c);
  const { slug } = c.req.param();
  if (!slugRe.test(slug)) return badRequest(c, 'Invalid slug');
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
  if (!hasPermission(user, 'catalog:delete')) return forbidden(c);
  const { slug } = c.req.param();
  if (!slugRe.test(slug)) return badRequest(c, 'Invalid slug');
  if (isReservedNamespace(slug)) return forbidden(c, 'Refusing to delete a reserved namespace');

  const argoAppName = `catalog-${slug}-manifests`;
  try {
    const [customApi, coreApi, readApi] = await Promise.all([
      getMergePatchCustomApi(user.clusterId),
      getCoreApiForCluster(user.clusterId),
      getCustomApiForCluster(user.clusterId),
    ]);

    // 0. Allowlist: only a namespace that belongs to an INSTALLED community app
    // may be deleted. Mirror the GET handler's label check — the static
    // RESERVED_NAMESPACES denylist above is defence-in-depth only and must not
    // be the sole guard (it cannot enumerate every platform namespace).
    const existing = await readApi.getNamespacedCustomObject({
      group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd', plural: 'applications',
      name: argoAppName,
    }).catch(() => null) as { metadata?: { labels?: Record<string, string> } } | null;
    if (!existing) return notFound(c, 'Community app not found');
    if (existing.metadata?.labels?.['infraweaver.io/source'] !== 'community-apps') {
      return forbidden(c, 'Refusing to delete: not a community app');
    }

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
    return c.json({ ok: false, error: errMessage(err, 'K8s cleanup failed') }, 502);
  }
});

communityAppsRoute.post('/bootstrap-refresh', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'apps:write')) return forbidden(c);
  await triggerBootstrapRefresh(user.clusterId);
  return c.json({ ok: true });
});

communityAppsRoute.post('/:slug/argocd-app', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'catalog:write')) return forbidden(c);
  const { slug } = c.req.param();
  if (!slugRe.test(slug)) return badRequest(c, 'Invalid slug');

  const body = await c.req.json().catch(() => ({}));
  const parsed = argoAppBodySchema.safeParse(body);
  if (!parsed.success) return invalidBody(c, parsed.error);
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
    return c.json({ ok: false, error: errMessage(err, 'Failed to create ArgoCD app') }, 502);
  }
});

// C6: create community-app secrets directly in the cluster instead of committing
// them to git. The secrets carry only our own labels (no argocd tracking label),
// so ArgoCD's prune/selfHeal will not adopt or delete them.
communityAppsRoute.post('/:slug/secrets', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'catalog:write')) return forbidden(c);
  if (user.clusterId === 'all') return badRequest(c, 'Select a specific cluster before performing this action');
  const { slug } = c.req.param();
  if (!slugRe.test(slug)) return badRequest(c, 'Invalid slug');

  const body = await c.req.json().catch(() => ({}));
  const parsed = secretsBodySchema.safeParse(body);
  if (!parsed.success) return invalidBody(c, parsed.error);
  const { namespace, secrets } = parsed.data;
  if (isReservedNamespace(namespace)) return forbidden(c, 'Refusing to write secrets into a reserved namespace');

  try {
    const [coreApi, customApi] = await Promise.all([
      getCoreApiForCluster(user.clusterId),
      getCustomApiForCluster(user.clusterId),
    ]);

    // Bind the target namespace to the app itself: secrets for `slug` may only
    // land in the namespace that community app owns. The reserved-namespace
    // denylist above is defence-in-depth only — the binding below is the guard.
    const argoApp = await customApi.getNamespacedCustomObject({
      group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd', plural: 'applications',
      name: `catalog-${slug}-manifests`,
    }).catch(() => null) as { metadata?: { labels?: Record<string, string> }; spec?: { destination?: { namespace?: string } } } | null;

    const existingNs = await coreApi.readNamespace({ name: namespace })
      .then((ns) => ns as { metadata?: { labels?: Record<string, string> } })
      .catch((err) => { if (k8sStatusCode(err) === 404) return null; throw err; });

    if (argoApp) {
      // Installed app: the namespace MUST be the Application's own destination.
      if (argoApp.metadata?.labels?.['infraweaver.io/source'] !== 'community-apps') {
        return forbidden(c, 'Refusing to write secrets: not a community app');
      }
      if (argoApp.spec?.destination?.namespace !== namespace) {
        return forbidden(c, 'Namespace does not belong to this community app');
      }
    } else if (existingNs) {
      // Fresh install (the ArgoCD Application is created right after this step,
      // so it may not exist yet): never adopt a pre-existing namespace we do not
      // own — only one previously created (and labeled) for this exact app.
      const nsLabels = existingNs.metadata?.labels;
      if (nsLabels?.['infraweaver.io/source'] !== 'community-apps' || nsLabels?.['app.kubernetes.io/name'] !== slug) {
        return forbidden(c, 'Namespace does not belong to this community app');
      }
    }

    // Ensure the target namespace exists (ArgoCD also creates it via
    // CreateNamespace=true, but that sync is async — create eagerly so the
    // Secret has a home immediately). Label it so later fresh-install requests
    // can prove ownership.
    if (!existingNs) {
      await coreApi.createNamespace({
        body: {
          apiVersion: 'v1', kind: 'Namespace',
          metadata: { name: namespace, labels: { 'app.kubernetes.io/name': slug, 'infraweaver.io/source': 'community-apps' } },
        },
      }).catch((e) => { if (k8sStatusCode(e) !== 409) throw e; });
    }

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
        // Only overwrite a pre-existing secret if it is itself community-apps-managed;
        // never clobber a secret owned by another controller/operator.
        const current = await coreApi.readNamespacedSecret({ name: s.name, namespace })
          .then((sec) => (sec as { metadata?: { labels?: Record<string, string> } }).metadata)
          .catch(() => undefined);
        if (current?.labels?.['infraweaver.io/source'] !== 'community-apps') {
          throw new Error(`Secret ${s.name} in ${namespace} already exists and is not community-apps managed`);
        }
        await coreApi.replaceNamespacedSecret({ name: s.name, namespace, body: secretBody });
      }
    }

    return c.json({ ok: true, count: secrets.length });
  } catch (err) {
    return c.json({ ok: false, error: errMessage(err, 'Failed to create secrets') }, 502);
  }
});
