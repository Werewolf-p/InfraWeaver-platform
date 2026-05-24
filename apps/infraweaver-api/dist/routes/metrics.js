import { Hono } from 'hono';
import { getCoreApiForCluster, getCustomApiForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
function parseCpuToMillicores(value) {
    if (!value) {
        return 0;
    }
    if (value.endsWith('n')) {
        return Math.round(Number.parseInt(value, 10) / 1_000_000);
    }
    if (value.endsWith('m')) {
        return Number.parseInt(value, 10) || 0;
    }
    return Math.round((Number.parseFloat(value) || 0) * 1000);
}
function parseMemoryToKi(value) {
    if (!value) {
        return 0;
    }
    if (value.endsWith('Ki')) {
        return Number.parseInt(value, 10) || 0;
    }
    if (value.endsWith('Mi')) {
        return (Number.parseInt(value, 10) || 0) * 1024;
    }
    if (value.endsWith('Gi')) {
        return (Number.parseInt(value, 10) || 0) * 1024 * 1024;
    }
    return Math.round((Number.parseInt(value, 10) || 0) / 1024);
}
function parseMemoryToMi(value) {
    if (!value) {
        return 0;
    }
    if (value.endsWith('Ki')) {
        return Math.round((Number.parseInt(value, 10) || 0) / 1024);
    }
    if (value.endsWith('Mi')) {
        return Number.parseInt(value, 10) || 0;
    }
    if (value.endsWith('Gi')) {
        return (Number.parseInt(value, 10) || 0) * 1024;
    }
    return Number.parseInt(value, 10) || 0;
}
export const metricsRoute = new Hono();
metricsRoute.get('/nodes', async (c) => {
    const user = c.get('user');
    if (!hasPermission(user, 'cluster:read')) {
        return c.json({ error: 'Forbidden' }, 403);
    }
    try {
        const [customApi, coreApi] = await Promise.all([
            getCustomApiForCluster(user.clusterId),
            getCoreApiForCluster(user.clusterId),
        ]);
        const [metricsResponse, nodesResponse] = await Promise.all([
            customApi.listClusterCustomObject({
                group: 'metrics.k8s.io',
                version: 'v1beta1',
                plural: 'nodes',
            }),
            coreApi.listNode(),
        ]);
        const capacityMap = {};
        for (const item of nodesResponse.items ?? []) {
            const node = item;
            const name = node.metadata?.name ?? '';
            capacityMap[name] = {
                cpuCores: Number.parseFloat(node.status?.capacity?.cpu ?? '0') || 0,
                memoryKi: parseMemoryToKi(node.status?.capacity?.memory),
                pods: Number.parseInt(node.status?.capacity?.pods ?? '110', 10) || 110,
            };
        }
        const metrics = (metricsResponse.items ?? []).map((item) => {
            const metric = item;
            const name = metric.metadata?.name ?? '';
            const cpuMillicores = parseCpuToMillicores(metric.usage?.cpu);
            const memoryKi = parseMemoryToKi(metric.usage?.memory);
            const capacity = capacityMap[name] ?? { cpuCores: 0, memoryKi: 0, pods: 110 };
            return {
                name,
                cpuPct: capacity.cpuCores > 0 ? Math.min(Math.round((cpuMillicores / (capacity.cpuCores * 1000)) * 100), 100) : 0,
                memPct: capacity.memoryKi > 0 ? Math.min(Math.round((memoryKi / capacity.memoryKi) * 100), 100) : 0,
                cpuMillicores,
                memKi: memoryKi,
            };
        });
        return c.json({ metrics, timestamp: new Date().toISOString(), clusterId: user.clusterId });
    }
    catch {
        return c.json({ error: 'Failed to fetch node metrics' }, 502);
    }
});
metricsRoute.get('/pods', async (c) => {
    const user = c.get('user');
    if (!hasPermission(user, 'cluster:read')) {
        return c.json({ error: 'Forbidden' }, 403);
    }
    try {
        const [customApi, coreApi] = await Promise.all([
            getCustomApiForCluster(user.clusterId),
            getCoreApiForCluster(user.clusterId),
        ]);
        const [metricsResponse, podsResponse] = await Promise.all([
            customApi.listClusterCustomObject({
                group: 'metrics.k8s.io',
                version: 'v1beta1',
                plural: 'pods',
            }),
            coreApi.listPodForAllNamespaces(),
        ]);
        const limitsMap = {};
        for (const item of podsResponse.items ?? []) {
            const pod = item;
            const key = `${pod.metadata?.namespace ?? ''}/${pod.metadata?.name ?? ''}`;
            limitsMap[key] = {};
            for (const container of pod.spec?.containers ?? []) {
                limitsMap[key][container.name ?? ''] = {
                    cpuLimit: parseCpuToMillicores(container.resources?.limits?.cpu),
                    memLimit: parseMemoryToMi(container.resources?.limits?.memory),
                };
            }
        }
        const pods = (metricsResponse.items ?? []).map((item) => {
            const metric = item;
            const key = `${metric.metadata?.namespace ?? ''}/${metric.metadata?.name ?? ''}`;
            return {
                namespace: metric.metadata?.namespace ?? '',
                name: metric.metadata?.name ?? '',
                containers: (metric.containers ?? []).map((container) => {
                    const limit = limitsMap[key]?.[container.name ?? ''] ?? { cpuLimit: 0, memLimit: 0 };
                    return {
                        name: container.name ?? '',
                        cpu_m: parseCpuToMillicores(container.usage?.cpu),
                        memory_mi: parseMemoryToMi(container.usage?.memory),
                        cpu_limit_m: limit.cpuLimit,
                        memory_limit_mi: limit.memLimit,
                    };
                }),
            };
        });
        return c.json({ pods, timestamp: new Date().toISOString(), clusterId: user.clusterId });
    }
    catch {
        return c.json({ error: 'Failed to fetch pod metrics' }, 502);
    }
});
//# sourceMappingURL=metrics.js.map