import * as k8s from '@kubernetes/client-node';
import { Hono } from 'hono';
import { broadcastToAgents, getConnectedAgents, sendToAgent } from '../lib/agent-registry.js';
import { hasPermission } from '../lib/rbac.js';
export const rbacSyncRoute = new Hono();
rbacSyncRoute.get('/sync', async (c) => {
    const user = c.get('user');
    if (!hasPermission(user, 'rbac:admin')) {
        return c.json({ error: 'Forbidden' }, 403);
    }
    const agents = getConnectedAgents();
    const rbacConfig = await loadRbacConfig();
    return c.json({
        rbacConfig,
        agents: agents.map((agent) => ({
            clusterId: agent.clusterId,
            connectedAt: agent.connectedAt,
            lastHeartbeat: agent.lastHeartbeat,
            status: agent.status,
        })),
    }, 200, { 'Cache-Control': 'no-store' });
});
rbacSyncRoute.post('/sync', async (c) => {
    const user = c.get('user');
    if (!hasPermission(user, 'rbac:admin')) {
        return c.json({ error: 'Forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const targetCluster = typeof body.clusterId === 'string' ? body.clusterId : undefined;
    const rbacConfig = await loadRbacConfig();
    const syncFrame = {
        type: 'rbac-sync',
        config: rbacConfig,
        syncedAt: new Date().toISOString(),
        ts: Date.now(),
    };
    if (targetCluster) {
        const sent = sendToAgent(targetCluster, syncFrame);
        return c.json({ synced: sent ? [targetCluster] : [], failed: sent ? [] : [targetCluster] });
    }
    broadcastToAgents(syncFrame);
    const agents = getConnectedAgents();
    return c.json({ synced: agents.map((agent) => agent.clusterId), failed: [] });
});
async function loadRbacConfig() {
    try {
        const kc = new k8s.KubeConfig();
        try {
            kc.loadFromCluster();
        }
        catch {
            kc.loadFromDefault();
        }
        const coreApi = kc.makeApiClient(k8s.CoreV1Api);
        const configMap = await coreApi.readNamespacedConfigMap({
            name: 'infraweaver-users',
            namespace: 'infraweaver-console',
        });
        return {
            users: configMap.data?.['users.yaml'] ?? '',
            source: 'configmap',
            loadedAt: new Date().toISOString(),
        };
    }
    catch {
        return { users: '', source: 'unavailable', loadedAt: new Date().toISOString() };
    }
}
//# sourceMappingURL=rbac-sync.js.map