import "server-only";
import { ApiException } from "@kubernetes/client-node";
import { makeCoreApi } from "@/lib/kube-client";

/**
 * Generic ConfigMap-backed JSON store — SERVER ONLY.
 *
 * Extracts the persistence pattern shared by access-store.ts, feedback-store.ts,
 * app-power.ts and addons-server.ts: state lives in a single ConfigMap in the
 * console namespace, serialized as JSON string(s) so the data is
 * human-inspectable via kubectl. Writes are optimistic-concurrency safe
 * (resourceVersion create-or-replace with a single conflict retry), and a
 * missing ConfigMap reads as `null` rather than throwing.
 *
 * Two layouts, matching the two existing conventions:
 *  - whole-object (default): the entire value is one JSON string under a single
 *    data key (`state` unless overridden) — feedback-store style.
 *  - per-key (`keys` option): each listed top-level property of T is serialized
 *    under its own data key — access-store style, nicer for kubectl inspection.
 *
 * This module is ADDITIVE foundation work: existing stores are unchanged and
 * can adopt it in a later migration phase.
 */

const DEFAULT_NAMESPACE = process.env.CONSOLE_NAMESPACE ?? process.env.POD_NAMESPACE ?? "infraweaver-console";
const DEFAULT_DATA_KEY = "state";

interface RawConfigMap {
  metadata?: { resourceVersion?: string };
  data?: Record<string, string | undefined>;
}

/**
 * Walk an error (and its `cause` chain) for a numeric HTTP status. The
 * kubernetes client throws `ApiException` with a numeric `code`; older client
 * versions and generic HTTP errors carry `statusCode`. String codes (e.g.
 * `ECONNRESET`) are ignored — this is a status inspection, not a regex over
 * the message text.
 */
function httpStatusOf(error: unknown): number | undefined {
  if (error instanceof ApiException) return error.code;
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== "object") break;
    const obj = current as Record<string, unknown>;
    if (typeof obj.statusCode === "number") return obj.statusCode;
    if (typeof obj.code === "number") return obj.code;
    current = obj.cause;
  }
  return undefined;
}

/** True when a kubernetes client error is a 404 (inspected via status code, not message text). */
export function isK8sNotFound(error: unknown): boolean {
  return httpStatusOf(error) === 404;
}

/** True when a kubernetes client error is a 409 optimistic-concurrency conflict. */
export function isK8sConflict(error: unknown): boolean {
  return httpStatusOf(error) === 409;
}

export interface ConfigMapJsonStoreOptions<T extends object> {
  /** ConfigMap name. */
  name: string;
  /** Namespace; defaults to the console namespace (CONSOLE_NAMESPACE / POD_NAMESPACE). */
  namespace?: string;
  /**
   * Per-key layout: each listed top-level property of T is serialized as its
   * own ConfigMap data key (access-store style). A corrupt or missing key is
   * simply absent from the loaded object, so callers should merge their own
   * defaults (e.g. `{ ...EMPTY_STATE, ...(await store.load()) }`).
   * When omitted, the whole value is one JSON string under `dataKey`.
   */
  keys?: ReadonlyArray<Extract<keyof T, string>>;
  /** Data key for whole-object layout. Default `"state"`. Ignored when `keys` is set. */
  dataKey?: string;
  /** Extra metadata labels merged over the standard managed-by labels. */
  labels?: Record<string, string>;
  /** Multi-cluster support; omitted = the console's own cluster (unchanged default). */
  clusterId?: string;
}

export interface ConfigMapJsonStore<T extends object> {
  /** Load the stored value, or `null` when the ConfigMap does not exist. */
  load(): Promise<T | null>;
  /** Create-or-replace the stored value (one conflict retry). */
  save(value: T): Promise<void>;
  /**
   * Read-modify-write with a single optimistic-concurrency retry on 409.
   * `fn` receives the freshly-loaded value (or `null` on first write) and
   * returns the next value to persist. Returns the persisted value.
   */
  mutate(fn: (current: T | null) => T | Promise<T>): Promise<T>;
}

function safeParseJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/**
 * Create a ConfigMap-backed JSON store for a single well-known ConfigMap.
 * Mirrors the access-store/feedback-store persistence pattern (404 → null,
 * resourceVersion create-or-replace, one conflict retry) behind a typed API.
 */
export function createConfigMapJsonStore<T extends object>(opts: ConfigMapJsonStoreOptions<T>): ConfigMapJsonStore<T> {
  const namespace = opts.namespace ?? DEFAULT_NAMESPACE;
  const dataKey = opts.dataKey ?? DEFAULT_DATA_KEY;
  if (!opts.name.trim()) throw new Error("configmap-store: `name` must be a non-empty ConfigMap name");

  async function readConfigMap(): Promise<RawConfigMap | null> {
    const coreApi = makeCoreApi(opts.clusterId);
    try {
      return (await coreApi.readNamespacedConfigMap({ name: opts.name, namespace })) as RawConfigMap;
    } catch (error) {
      if (isK8sNotFound(error)) return null;
      throw error;
    }
  }

  function parseValue(configMap: RawConfigMap): T {
    if (opts.keys) {
      const out: Record<string, unknown> = {};
      for (const key of opts.keys) {
        const parsed = safeParseJson(configMap.data?.[key]);
        if (parsed !== undefined) out[key] = parsed;
      }
      return out as T;
    }
    const parsed = safeParseJson(configMap.data?.[dataKey]);
    return (parsed ?? {}) as T;
  }

  function serializeValue(value: T): Record<string, string> {
    const data: Record<string, string> = { updatedAt: new Date().toISOString() };
    if (opts.keys) {
      for (const key of opts.keys) {
        const serialized = JSON.stringify((value as Record<string, unknown>)[key]);
        // JSON.stringify(undefined) is undefined; ConfigMap data values must be strings.
        if (serialized !== undefined) data[key] = serialized;
      }
      return data;
    }
    data[dataKey] = JSON.stringify(value);
    return data;
  }

  async function writeConfigMap(value: T, resourceVersion: string | undefined): Promise<void> {
    const coreApi = makeCoreApi(opts.clusterId);
    const body = {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: opts.name,
        namespace,
        labels: { "app.kubernetes.io/managed-by": "infraweaver-console", ...(opts.labels ?? {}) },
        ...(resourceVersion ? { resourceVersion } : {}),
      },
      data: serializeValue(value),
    };
    if (resourceVersion) {
      await coreApi.replaceNamespacedConfigMap({ name: opts.name, namespace, body });
    } else {
      await coreApi.createNamespacedConfigMap({ namespace, body });
    }
  }

  return {
    async load(): Promise<T | null> {
      const configMap = await readConfigMap();
      if (!configMap) return null;
      return parseValue(configMap);
    },

    async save(value: T): Promise<void> {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const existing = await readConfigMap();
        try {
          await writeConfigMap(value, existing?.metadata?.resourceVersion);
          return;
        } catch (error) {
          if (!isK8sConflict(error) || attempt === 1) throw error;
        }
      }
      throw new Error(`Failed to persist ConfigMap ${namespace}/${opts.name}`);
    },

    async mutate(fn: (current: T | null) => T | Promise<T>): Promise<T> {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const configMap = await readConfigMap();
        const current = configMap ? parseValue(configMap) : null;
        const next = await fn(current);
        try {
          await writeConfigMap(next, configMap?.metadata?.resourceVersion);
          return next;
        } catch (error) {
          if (!isK8sConflict(error) || attempt === 1) throw error;
        }
      }
      throw new Error(`Failed to persist ConfigMap ${namespace}/${opts.name}`);
    },
  };
}
