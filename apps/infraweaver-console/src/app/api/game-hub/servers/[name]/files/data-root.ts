import type * as k8s from "@kubernetes/client-node";
import { getServerDeployment, readServerEgg, type GameHubClients } from "@/lib/game-hub-server";

interface PvcMount {
  mountPath: string;
  subPath?: string;
  volumeName: string;
}

const SYSTEM_MOUNT_PREFIXES = ["/var/run", "/proc", "/sys", "/dev", "/etc"];

/**
 * Resolves the real data directory the file browser should root at.
 *
 * Game eggs declare a `mountPath`, but different images mount their persistent
 * data at different locations and the egg metadata can be stale or missing. The
 * authoritative source of truth is the pod's persistent volume claim mount, so
 * we derive the root from the running pod and fall back to the egg mount path
 * only when no PVC-backed mount can be found.
 */
export function resolveDataRoot(
  pod: k8s.V1Pod | null | undefined,
  eggMountPath: string,
): string {
  const fallback = eggMountPath || "/data";
  const spec = pod?.spec;
  if (!spec) return fallback;

  const pvcVolumeNames = new Set(
    (spec.volumes ?? [])
      .filter((volume) => volume.persistentVolumeClaim?.claimName)
      .map((volume) => volume.name)
      .filter((volumeName): volumeName is string => Boolean(volumeName)),
  );
  if (pvcVolumeNames.size === 0) return fallback;

  const mounts: PvcMount[] = [];
  for (const container of spec.containers ?? []) {
    for (const mount of container.volumeMounts ?? []) {
      if (mount.name && mount.mountPath && pvcVolumeNames.has(mount.name)) {
        mounts.push({ mountPath: mount.mountPath, subPath: mount.subPath, volumeName: mount.name });
      }
    }
  }
  if (mounts.length === 0) return fallback;

  // Prefer the egg's declared mount path when it is actually backed by a PVC
  // mount in the pod — that keeps egg config and reality in sync.
  const eggMatch = mounts.find((mount) => mount.mountPath === fallback);
  if (eggMatch) return eggMatch.mountPath;

  const score = (mount: PvcMount) => {
    let value = 0;
    // The root of the PVC (no subPath) is the data directory; sub-mounts are
    // typically secondary views of the same volume.
    if (!mount.subPath) value += 100;
    // A shallower mount path is more likely to be the top-level data root.
    value -= mount.mountPath.split("/").filter(Boolean).length;
    if (SYSTEM_MOUNT_PREFIXES.some((prefix) => mount.mountPath.startsWith(prefix))) {
      value -= 1000;
    }
    return value;
  };

  const best = [...mounts].sort((a, b) => score(b) - score(a))[0];
  return best?.mountPath || fallback;
}

/**
 * Resolves the data root for a server by combining the egg metadata (resolved
 * with the deployment so the game type is correct) with the running pod's
 * actual persistent volume mounts.
 */
export async function resolveServerDataRoot(
  clients: GameHubClients,
  name: string,
  pod: k8s.V1Pod | null | undefined,
): Promise<string> {
  const deployment = await getServerDeployment(clients.appsApi, name).catch(() => null);
  const egg = await readServerEgg(clients.coreApi, name, deployment ?? undefined);
  return resolveDataRoot(pod, egg.mountPath);
}
