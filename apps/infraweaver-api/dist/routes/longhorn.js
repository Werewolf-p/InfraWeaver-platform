import { Hono } from 'hono';
import { getCustomApiForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
export const longhornRoute = new Hono();
longhornRoute.get('/volumes', async (c) => {
    const user = c.get('user');
    if (!hasPermission(user, 'cluster:read')) {
        return c.json({ error: 'Forbidden' }, 403);
    }
    try {
        const customApi = await getCustomApiForCluster(user.clusterId);
        const response = await customApi.listNamespacedCustomObject({
            group: 'longhorn.io',
            version: 'v1beta2',
            namespace: 'longhorn-system',
            plural: 'volumes',
        });
        const volumes = (response.items ?? []).map((item) => {
            const volume = item;
            return {
                name: volume.metadata?.name ?? '',
                size: Number.parseInt(volume.spec?.size ?? '0', 10) || 0,
                actualSize: Number.parseInt(volume.status?.actualSize ?? '0', 10) || 0,
                robustness: volume.status?.robustness ?? 'unknown',
                numberOfReplicas: volume.spec?.numberOfReplicas ?? 0,
                state: volume.status?.state ?? 'unknown',
                kubernetesStatus: volume.status?.kubernetesStatus ?? null,
            };
        });
        return c.json(volumes);
    }
    catch {
        return c.json({ error: 'Failed to fetch Longhorn volumes' }, 502);
    }
});
longhornRoute.get('/backups', async (c) => {
    const user = c.get('user');
    if (!hasPermission(user, 'cluster:read')) {
        return c.json({ error: 'Forbidden' }, 403);
    }
    try {
        const customApi = await getCustomApiForCluster(user.clusterId);
        const response = await customApi.listNamespacedCustomObject({
            group: 'longhorn.io',
            version: 'v1beta2',
            namespace: 'longhorn-system',
            plural: 'backupvolumes',
        });
        const backupVolumes = (response.items ?? []).map((item) => {
            const backupVolume = item;
            return {
                volumeName: backupVolume.metadata?.name ?? '',
                backupCount: Number.parseInt(String(backupVolume.status?.backupCount ?? '0'), 10) || 0,
                lastBackupAt: backupVolume.status?.lastBackupAt ?? null,
                lastBackupName: backupVolume.status?.lastBackupName ?? '',
                size: Number.parseInt(String(backupVolume.status?.size ?? '0'), 10) || 0,
            };
        });
        return c.json(backupVolumes);
    }
    catch {
        return c.json({ error: 'Failed to fetch Longhorn backup volumes' }, 502);
    }
});
longhornRoute.get('/backups/:volumeName', async (c) => {
    const user = c.get('user');
    if (!hasPermission(user, 'cluster:read')) {
        return c.json({ error: 'Forbidden' }, 403);
    }
    const { volumeName } = c.req.param();
    try {
        const customApi = await getCustomApiForCluster(user.clusterId);
        const response = await customApi.listNamespacedCustomObject({
            group: 'longhorn.io',
            version: 'v1beta2',
            namespace: 'longhorn-system',
            plural: 'backups',
        });
        const backups = (response.items ?? [])
            .map((item) => {
            const backup = item;
            return {
                volumeName: backup.spec?.volumeName ?? backup.metadata?.labels?.['backup.longhorn.io/volume-name'] ?? '',
                name: backup.metadata?.name ?? '',
                createdAt: backup.status?.snapshotCreatedAt ?? backup.metadata?.creationTimestamp ?? '',
                size: Number.parseInt(String(backup.status?.size ?? '0'), 10) || 0,
                state: backup.status?.state ?? 'unknown',
                backupURL: backup.status?.url ?? '',
                labels: backup.metadata?.labels ?? {},
            };
        })
            .filter((backup) => backup.volumeName === volumeName)
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
            .map(({ volumeName: _volumeName, ...backup }) => backup);
        return c.json(backups);
    }
    catch {
        return c.json({ error: 'Failed to fetch Longhorn backups' }, 502);
    }
});
longhornRoute.post('/restore', async (c) => {
    const user = c.get('user');
    if (!hasPermission(user, 'cluster:admin')) {
        return c.json({ error: 'Forbidden' }, 403);
    }
    const body = await c.req.json().catch(() => ({}));
    const volumeName = typeof body.volumeName === 'string' ? body.volumeName.trim() : '';
    const backupURL = typeof body.backupURL === 'string' ? body.backupURL.trim() : '';
    const targetVolumeName = typeof body.targetVolumeName === 'string' ? body.targetVolumeName.trim() : '';
    if (!volumeName || !backupURL) {
        return c.json({ error: 'volumeName and backupURL are required' }, 400);
    }
    const restoreVolumeName = targetVolumeName || volumeName;
    try {
        const customApi = await getCustomApiForCluster(user.clusterId);
        await customApi.createNamespacedCustomObject({
            group: 'longhorn.io',
            version: 'v1beta2',
            namespace: 'longhorn-system',
            plural: 'volumes',
            body: {
                apiVersion: 'longhorn.io/v1beta2',
                kind: 'Volume',
                metadata: {
                    name: restoreVolumeName,
                    namespace: 'longhorn-system',
                },
                spec: {
                    fromBackup: backupURL,
                    numberOfReplicas: 3,
                    dataLocality: 'best-effort',
                    accessMode: 'rwo',
                },
            },
        });
        return c.json({
            ok: true,
            volumeName: restoreVolumeName,
            message: `Restore started for ${restoreVolumeName}`,
        });
    }
    catch {
        return c.json({ error: 'Failed to start Longhorn restore' }, 502);
    }
});
//# sourceMappingURL=longhorn.js.map