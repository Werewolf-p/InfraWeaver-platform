// Stable dedup fingerprint for a raw signal.
//
// A flapping pod emits many near-identical Warning events whose only difference
// is the volatile pod-hash suffix on the object name (e.g. the ReplicaSet hash
// and the 5-char pod suffix). Stripping those collapses the storm to one group.

import type { RawSignal } from "./types";

/**
 * Remove the volatile suffixes Kubernetes appends to workload children so that
 * `web-7d9f8b2c1a-abcde`, `web-abcde` and `web-0` all normalize to `web`.
 */
export function stripVolatileSuffix(name: string): string {
  return name
    .replace(/-[a-f0-9]{6,10}-[a-z0-9]{5}$/i, "") // deployment: <rs-hash>-<pod-hash>
    .replace(/-[a-z0-9]{5}$/i, "") // bare replicaset/pod hash
    .replace(/-\d+$/, ""); // statefulset ordinal
}

/**
 * Deterministic fingerprint = lowercased `app|cause|reason|<stripped object>`.
 * Two signals with the same reason + object (ignoring volatile suffixes) share
 * a fingerprint and therefore a group.
 */
export function fingerprint(signal: RawSignal): string {
  const object = signal.object ? stripVolatileSuffix(signal.object) : "";
  return [signal.app ?? "", signal.cause, signal.reason ?? "", object].join("|").toLowerCase();
}
