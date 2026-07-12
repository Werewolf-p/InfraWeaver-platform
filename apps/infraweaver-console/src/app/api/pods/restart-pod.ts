import type * as k8s from "@kubernetes/client-node";
import { isPodInstalling } from "@/lib/pod-install-state";

/**
 * Restart (delete) a pod, guarding against pods that are mid-install: for a
 * Recreate-strategy Deployment the replacement re-runs the whole install, so a
 * restart repeated during a rollout churns it indefinitely. A read failure
 * fails open (can't confirm state) — `force` always bypasses the guard.
 *
 * Shared by /api/pods/restart and /api/pods/bulk-restart. Delete errors
 * propagate to the caller.
 */
export async function restartPodSafely(
  coreApi: k8s.CoreV1Api,
  target: { namespace: string; name: string },
  force: boolean | undefined,
): Promise<"restarted" | "skipped-installing"> {
  const { namespace, name } = target;
  if (!force) {
    const pod = await coreApi.readNamespacedPod({ namespace, name }).catch(() => null);
    if (pod && isPodInstalling(pod)) return "skipped-installing";
  }
  await coreApi.deleteNamespacedPod({ namespace, name });
  return "restarted";
}
