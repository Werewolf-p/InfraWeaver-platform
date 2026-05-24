import { Hono } from 'hono';
import { z } from 'zod';
import * as k8s from '@kubernetes/client-node';
import { getCoreApiForCluster, getCustomApiForCluster, getKcForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
const APP_SOURCE_RESOLUTION_ATTEMPTS = 6;
const APP_SOURCE_RESOLUTION_DELAY_MS = 5000;
const argoAppBodySchema = z.object({
    repoUrl: z.string().url(),
    baseDir: z.string().min(1).max(500),
    namespace: z.string().min(1).max(63),
});
const slugRe = /^[a-z0-9-]+$/;
async function getMergePatchCustomApi(clusterId) {
    const kc = await getKcForCluster(clusterId);
    const cluster = kc.getCurrentCluster();
    if (!cluster)
        throw new Error('No active cluster');
    const mergePatchMiddleware = {
        pre: async (ctx) => {
            if (ctx.getHttpMethod() === 'PATCH')
                ctx.setHeaderParam('Content-Type', 'application/merge-patch+json');
            return ctx;
        },
        post: async (rsp) => rsp,
    };
    const cfg = k8s.createConfiguration({
        baseServer: new k8s.ServerConfiguration(cluster.server, {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        authMethods: { default: kc },
        promiseMiddleware: [mergePatchMiddleware],
    });
    return new k8s.CustomObjectsApi(cfg);
}
async function triggerBootstrapRefresh(clusterId) {
    try {
        const customApi = await getMergePatchCustomApi(clusterId);
        await customApi.patchNamespacedCustomObject({
            group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd', plural: 'applications', name: 'bootstrap',
            body: { metadata: { annotations: { 'argocd.argoproj.io/refresh': 'hard' } } },
        });
    }
    catch { /* non-fatal */ }
}
export const communityAppsRoute = new Hono();
communityAppsRoute.get('/:slug', async (c) => {
    const user = c.get('user');
    if (!hasPermission(user, 'apps:read'))
        return c.json({ error: 'Forbidden' }, 403);
    const { slug } = c.req.param();
    if (!slugRe.test(slug))
        return c.json({ error: 'Invalid slug' }, 400);
    try {
        const customApi = await getCustomApiForCluster(user.clusterId);
        const existing = await customApi.getNamespacedCustomObject({
            group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd', plural: 'applications',
            name: `catalog-${slug}-manifests`,
        }).catch(() => null);
        if (!existing)
            return c.json({ exists: false });
        const app = existing;
        return c.json({ exists: true, isCommunityApp: app.metadata?.labels?.['infraweaver.io/source'] === 'community-apps' });
    }
    catch {
        return c.json({ exists: false });
    }
});
communityAppsRoute.delete('/:slug', async (c) => {
    const user = c.get('user');
    if (!hasPermission(user, 'catalog:delete'))
        return c.json({ error: 'Forbidden' }, 403);
    const { slug } = c.req.param();
    if (!slugRe.test(slug))
        return c.json({ error: 'Invalid slug' }, 400);
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
        }).catch(() => { });
        // 2. Delete namespace (cascade-deletes deployments, pvcs, etc.)
        await coreApi.deleteNamespace({ name: slug }).catch(() => { });
        // 3. Delete the ArgoCD Application resource
        await customApi.deleteNamespacedCustomObject({
            group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd', plural: 'applications',
            name: argoAppName,
        }).catch(() => { });
        return c.json({ ok: true });
    }
    catch (err) {
        return c.json({ ok: false, error: err instanceof Error ? err.message : 'K8s cleanup failed' }, 502);
    }
});
communityAppsRoute.post('/bootstrap-refresh', async (c) => {
    const user = c.get('user');
    if (!hasPermission(user, 'apps:write'))
        return c.json({ error: 'Forbidden' }, 403);
    await triggerBootstrapRefresh(user.clusterId);
    return c.json({ ok: true });
});
communityAppsRoute.post('/:slug/argocd-app', async (c) => {
    const user = c.get('user');
    if (!hasPermission(user, 'catalog:write'))
        return c.json({ error: 'Forbidden' }, 403);
    const { slug } = c.req.param();
    if (!slugRe.test(slug))
        return c.json({ error: 'Invalid slug' }, 400);
    const body = await c.req.json().catch(() => ({}));
    const parsed = argoAppBodySchema.safeParse(body);
    if (!parsed.success)
        return c.json({ error: parsed.error.flatten() }, 400);
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
        }).catch(() => { });
        // Poll until ArgoCD resolves the app source (max 30s)
        const mergePatchApi = await getMergePatchCustomApi(user.clusterId);
        for (let attempt = 0; attempt < APP_SOURCE_RESOLUTION_ATTEMPTS; attempt++) {
            await mergePatchApi.patchNamespacedCustomObject({
                group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd', plural: 'applications',
                name: argoAppName, body: { metadata: { annotations: { 'argocd.argoproj.io/refresh': 'hard' } } },
            }).catch(() => { });
            await new Promise((resolve) => setTimeout(resolve, APP_SOURCE_RESOLUTION_DELAY_MS));
            try {
                const application = await customApi.getNamespacedCustomObject({
                    group: 'argoproj.io', version: 'v1alpha1', namespace: 'argocd', plural: 'applications', name: argoAppName,
                });
                const comparisonError = application.status?.conditions?.find((cond) => cond.type === 'ComparisonError');
                if (!comparisonError || !/app path does not exist/i.test(comparisonError.message ?? ''))
                    break;
            }
            catch { /* keep retrying */ }
        }
        return c.json({ ok: true, argoAppName });
    }
    catch (err) {
        return c.json({ ok: false, error: err instanceof Error ? err.message : 'Failed to create ArgoCD app' }, 502);
    }
});
//# sourceMappingURL=community-apps.js.map