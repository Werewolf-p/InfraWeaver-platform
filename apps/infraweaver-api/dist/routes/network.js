import { Hono } from 'hono';
import { getCoreApiForCluster, getCustomApiForCluster, getNetworkApiForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
export const networkRoute = new Hono();
networkRoute.get('/topology', async (c) => {
    const user = c.get('user');
    if (!hasPermission(user, 'config:read'))
        return c.json({ error: 'Forbidden' }, 403);
    try {
        const [coreApi, customApi] = await Promise.all([
            getCoreApiForCluster(user.clusterId),
            getCustomApiForCluster(user.clusterId),
        ]);
        const [svcsResp, podsResp, ingressRoutesResp] = await Promise.allSettled([
            coreApi.listServiceForAllNamespaces(),
            coreApi.listPodForAllNamespaces(),
            customApi.listClusterCustomObject({ group: 'traefik.io', version: 'v1alpha1', plural: 'ingressroutes' }),
        ]);
        const nodes = [{ id: 'traefik', type: 'ingress-controller', name: 'Traefik', namespace: 'traefik', status: 'healthy' }];
        const edges = [];
        if (ingressRoutesResp.status === 'fulfilled') {
            for (const ir of (ingressRoutesResp.value.items ?? [])) {
                const r = ir;
                const id = `ir-${r.metadata?.namespace}-${r.metadata?.name}`;
                nodes.push({ id, type: 'ingressroute', name: r.metadata?.name ?? '', namespace: r.metadata?.namespace ?? '', status: 'healthy' });
                edges.push({ source: 'traefik', target: id });
                for (const route of r.spec?.routes ?? []) {
                    for (const svc of route.services ?? []) {
                        edges.push({ source: id, target: `svc-${svc.namespace ?? r.metadata?.namespace}-${svc.name}` });
                    }
                }
            }
        }
        if (svcsResp.status === 'fulfilled') {
            for (const svc of (svcsResp.value.items ?? [])) {
                const s = svc;
                if (s.spec?.type === 'ClusterIP' && s.metadata?.name !== 'kubernetes') {
                    const id = `svc-${s.metadata?.namespace}-${s.metadata?.name}`;
                    if (!nodes.find((n) => n.id === id)) {
                        nodes.push({ id, type: 'service', name: s.metadata?.name ?? '', namespace: s.metadata?.namespace ?? '', status: 'healthy' });
                    }
                }
            }
        }
        if (podsResp.status === 'fulfilled' && svcsResp.status === 'fulfilled') {
            const svcs = svcsResp.value.items ?? [];
            for (const pod of (podsResp.value.items ?? [])) {
                const p = pod;
                const phase = p.status?.phase ?? 'Unknown';
                const ready = p.status?.conditions?.find((cond) => cond.type === 'Ready')?.status === 'True';
                const status = phase === 'Running' && ready ? 'healthy' : phase === 'Running' ? 'degraded' : 'down';
                const id = `pod-${p.metadata?.namespace}-${p.metadata?.name}`;
                nodes.push({ id, type: 'pod', name: p.metadata?.name ?? '', namespace: p.metadata?.namespace ?? '', status });
                for (const svc of svcs) {
                    const s = svc;
                    if (s.metadata?.namespace !== p.metadata?.namespace || !s.spec?.selector)
                        continue;
                    const podLabels = p.metadata?.labels ?? {};
                    if (Object.entries(s.spec.selector).every(([k, v]) => podLabels[k] === v)) {
                        edges.push({ source: `svc-${s.metadata?.namespace}-${s.metadata?.name}`, target: id });
                    }
                }
            }
        }
        return c.json({ nodes, edges });
    }
    catch {
        return c.json({ nodes: [], edges: [] }, 502);
    }
});
networkRoute.get('/policies', async (c) => {
    const user = c.get('user');
    if (!hasPermission(user, 'cluster:read'))
        return c.json({ error: 'Forbidden' }, 403);
    try {
        const netApi = await getNetworkApiForCluster(user.clusterId);
        const res = await netApi.listNetworkPolicyForAllNamespaces();
        const policies = res.items.map((item) => {
            const p = item;
            return {
                namespace: p.metadata?.namespace ?? '',
                name: p.metadata?.name ?? '',
                podSelector: p.spec?.podSelector ?? {},
                ingressRules: p.spec?.ingress?.length ?? 0,
                egressRules: p.spec?.egress?.length ?? 0,
                policyTypes: p.spec?.policyTypes ?? [],
                createdAt: p.metadata?.creationTimestamp ?? '',
            };
        });
        return c.json({ policies });
    }
    catch {
        return c.json({ policies: [] }, 502);
    }
});
//# sourceMappingURL=network.js.map