import "server-only";

/**
 * ExternalSecret lifecycle collector — SERVER ONLY.
 *
 * For every ExternalSecret: reads the Ready condition, `spec.target.deletionPolicy`,
 * and all referenced OpenBao keys, then resolves which referenced keys are
 * actually present in OpenBao. The output flags the "Retain trap": with
 * `deletionPolicy: Retain`, ESO fails the WHOLE target secret if ANY referenced
 * key is missing (see memory: console-es-retain-freshinstall-seedgate).
 */

import * as k8s from "@kubernetes/client-node";
import { listCustomItems } from "@/lib/k8s";
import { readKv } from "@/lib/openbao/kv";
import {
  detectRetainTrap,
  extractReferencedKeys,
  referencedKeyId,
  type EsLifecycle,
  type ReferencedKey,
} from "@/lib/secrets/lifecycle-types";

interface RawExternalSecret {
  metadata?: { name?: string; namespace?: string };
  spec?: {
    target?: { name?: string; deletionPolicy?: string };
    data?: Array<{ remoteRef?: { key?: string; property?: string } }>;
    dataFrom?: Array<{ extract?: { key?: string } }>;
  };
  status?: {
    conditions?: Array<{ type?: string; status?: string; message?: string; lastTransitionTime?: string }>;
  };
}

/** Read a KV path once (best-effort); return its key set, or null when absent/unreadable. */
async function loadKvKeys(path: string, cache: Map<string, Set<string> | null>): Promise<Set<string> | null> {
  if (cache.has(path)) return cache.get(path) ?? null;
  let keys: Set<string> | null;
  try {
    const data = await readKv(path);
    keys = data && typeof data === "object" ? new Set(Object.keys(data as Record<string, unknown>)) : null;
  } catch {
    // Unreadable path (timeout, permission) — do not fabricate presence; treat as
    // "unknown" (null) so we never falsely flag a trap on a transient blip.
    keys = null;
  }
  cache.set(path, keys);
  return keys;
}

/**
 * Resolve which referenced keys are missing in OpenBao. A key is "missing" only
 * when the path IS readable AND the property is absent — an unreadable path
 * (null) is treated as unknown, not missing, to avoid false Retain-trap alarms.
 */
async function resolveMissingKeys(
  referenced: ReferencedKey[],
  cache: Map<string, Set<string> | null>,
): Promise<string[]> {
  const missing: string[] = [];
  for (const ref of referenced) {
    const keys = await loadKvKeys(ref.path, cache);
    if (keys === null) continue; // unknown, not missing
    if (ref.property === null) {
      // whole-path dataFrom extract: missing only if the path has no keys at all
      if (keys.size === 0) missing.push(referencedKeyId(ref));
    } else if (!keys.has(ref.property)) {
      missing.push(referencedKeyId(ref));
    }
  }
  return missing;
}

/**
 * Collect per-ExternalSecret lifecycle. `resolveKeys=false` skips the OpenBao
 * cross-check (e.g. when OpenBao is unreachable) and reports no missing keys /
 * no traps rather than throwing.
 */
export async function collectEsLifecycle(
  customApi: k8s.CustomObjectsApi,
  options: { resolveKeys?: boolean } = {},
): Promise<EsLifecycle[]> {
  const resolveKeys = options.resolveKeys ?? true;
  const items = await listCustomItems<RawExternalSecret>(customApi, {
    group: "external-secrets.io",
    version: "v1beta1",
    plural: "externalsecrets",
  });

  const kvCache = new Map<string, Set<string> | null>();
  const results: EsLifecycle[] = [];

  for (const es of items) {
    const readyCond = (es.status?.conditions ?? []).find((c) => c.type === "Ready");
    const referencedKeys = extractReferencedKeys(es.spec);
    const deletionPolicy = es.spec?.target?.deletionPolicy ?? "";
    const missingKeys = resolveKeys ? await resolveMissingKeys(referencedKeys, kvCache) : [];

    results.push({
      name: es.metadata?.name ?? "",
      namespace: es.metadata?.namespace ?? "",
      ready: readyCond?.status === "True",
      deletionPolicy,
      targetSecret: es.spec?.target?.name ?? es.metadata?.name ?? "",
      referencedKeys,
      missingKeys,
      isRetainTrap: detectRetainTrap(deletionPolicy, missingKeys.length),
      lastSync: readyCond?.lastTransitionTime ?? null,
      message: readyCond?.message ?? null,
    });
  }

  return results;
}
