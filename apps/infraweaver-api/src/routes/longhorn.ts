import { Hono } from 'hono';
import { getCustomApiForCluster } from '../lib/k8s-client.js';
import { hasPermission } from '../lib/rbac.js';
import type { AppBindings } from '../types/index.js';

type LonghornVolume = {
  metadata?: { name?: string };
  spec?: { size?: string; numberOfReplicas?: number };
  status?: {
    actualSize?: string;
    robustness?: string;
    state?: string;
    kubernetesStatus?: unknown;
  };
};

type LonghornBackupVolume = {
  metadata?: { name?: string };
  status?: {
    backupCount?: number | string;
    lastBackupAt?: string;
    lastBackupName?: string;
    size?: number | string;
  };
};

type LonghornBackup = {
  metadata?: {
    name?: string;
    creationTimestamp?: string;
    labels?: Record<string, string>;
  };
  spec?: { volumeName?: string };
  status?: {
    snapshotCreatedAt?: string;
    size?: number | string;
    state?: string;
    url?: string;
  };
};

export const longhornRoute = new Hono<AppBindings>();

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
    }) as { items?: unknown[] };

    const volumes = (response.items ?? []).map((item: unknown) => {
      const volume = item as LonghornVolume;

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
  } catch {
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
    }) as { items?: unknown[] };

    const backupVolumes = (response.items ?? []).map((item: unknown) => {
      const backupVolume = item as LonghornBackupVolume;

      return {
        volumeName: backupVolume.metadata?.name ?? '',
        backupCount: Number.parseInt(String(backupVolume.status?.backupCount ?? '0'), 10) || 0,
        lastBackupAt: backupVolume.status?.lastBackupAt ?? null,
        lastBackupName: backupVolume.status?.lastBackupName ?? '',
        size: Number.parseInt(String(backupVolume.status?.size ?? '0'), 10) || 0,
      };
    });

    return c.json(backupVolumes);
  } catch {
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
    }) as { items?: unknown[] };

    const backups = (response.items ?? [])
      .map((item: unknown) => {
        const backup = item as LonghornBackup;
        return {
          volumeName: backup.spec?.volumeName ?? backup.metadata?.labels?.['backup.longhorn.io/volume-name'] ?? '',
          name: backup.metadata?.name ?? '',
          createdAt: backup.status?.snapshotCreatedAt ?? backup.metadata?.creationTimestamp ?? '',
          size: Number.parseInt(String(backup.status?.size ?? '0'), 10) || 0,
          state: backup.status?.state ?? 'unknown',
          backupURL: (backup.status as Record<string, unknown>)?.url as string ?? '',
          labels: backup.metadata?.labels ?? {},
        };
      })
      .filter((backup) => backup.volumeName === volumeName)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(({ volumeName: _volumeName, ...backup }) => backup);

    return c.json(backups);
  } catch {
    return c.json({ error: 'Failed to fetch Longhorn backups' }, 502);
  }
});

longhornRoute.post('/restore', async (c) => {
  const user = c.get('user');
  if (!hasPermission(user, 'cluster:admin')) {
    return c.json({ error: 'Forbidden' }, 403);
  }

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
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
  } catch {
    return c.json({ error: 'Failed to start Longhorn restore' }, 502);
  }
});
