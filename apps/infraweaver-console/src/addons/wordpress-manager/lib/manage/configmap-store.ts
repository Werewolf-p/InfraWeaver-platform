import "server-only";
import { makeCoreApi } from "@/lib/kube-client";
import { isK8sNotFound, isTransientApiError } from "../k8s-errors";

/**
 * Generic optimistic-concurrency ConfigMap key/value store shared by the Manage
 * durable-snapshot stores — the per-site overview map (site-snapshot.ts) and the
 * per-site panel maps (panel-snapshot.ts). Both need the exact same
 * read-modify-write-with-retry over a namespaced ConfigMap; only the object name
 * and the data keys differ. Factoring the I/O here keeps each store to just its
 * own serialize/shape logic and its bounding rules.
 *
 * Same optimistic-lock pattern as iwsl-link-store / access-store: a conflicting
 * write (409) or a transient apiserver drop is retried with full-jitter backoff,
 * and the mutator edits a freshly-read data map each attempt so a concurrent
 * writer that landed between our read and write is merged, not clobbered.
 */

const CONSOLE_NAMESPACE = process.env.CONSOLE_NAMESPACE ?? process.env.POD_NAMESPACE ?? "infraweaver-console";

/** Labels stamped on every Manage snapshot ConfigMap — human-inspectable via kubectl. */
const STORE_LABELS = {
  "app.kubernetes.io/managed-by": "infraweaver-console",
  "infraweaver.io/component": "wordpress",
} as const;

/** Reserved data key carrying the ConfigMap's own write timestamp — never a payload key. */
export const RESERVED_UPDATED_AT_KEY = "updatedAt";

export interface ConfigMapState {
  data: Record<string, string>;
  resourceVersion?: string;
}

interface RawConfigMap {
  metadata?: { resourceVersion?: string };
  data?: Record<string, string | undefined>;
}

/** Read a ConfigMap's string data + resourceVersion; a missing map reads as empty. */
export async function readConfigMapData(name: string): Promise<ConfigMapState> {
  const core = makeCoreApi();
  try {
    const cm = (await core.readNamespacedConfigMap({ name, namespace: CONSOLE_NAMESPACE })) as RawConfigMap;
    const data: Record<string, string> = {};
    for (const [key, value] of Object.entries(cm.data ?? {})) {
      if (typeof value === "string") data[key] = value;
    }
    return { data, resourceVersion: cm.metadata?.resourceVersion };
  } catch (err) {
    if (isK8sNotFound(err)) return { data: {} };
    throw err;
  }
}

async function writeConfigMapData(name: string, state: ConfigMapState): Promise<void> {
  const core = makeCoreApi();
  const body = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name,
      namespace: CONSOLE_NAMESPACE,
      labels: STORE_LABELS,
      ...(state.resourceVersion ? { resourceVersion: state.resourceVersion } : {}),
    },
    data: { ...state.data, [RESERVED_UPDATED_AT_KEY]: new Date().toISOString() },
  };
  if (state.resourceVersion) {
    await core.replaceNamespacedConfigMap({ name, namespace: CONSOLE_NAMESPACE, body });
  } else {
    await core.createNamespacedConfigMap({ namespace: CONSOLE_NAMESPACE, body });
  }
}

/** How many times a conflicting read-modify-write is retried (mirrors iwsl-link-store). */
const MUTATE_MAX_ATTEMPTS = 6;
const MUTATE_BACKOFF_BASE_MS = 25;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Full-jitter exponential backoff so lock-stepped writers don't re-collide. */
function backoffDelayMs(retry: number): number {
  const ceiling = MUTATE_BACKOFF_BASE_MS * 2 ** retry;
  return Math.floor(Math.random() * ceiling);
}

function isWriteConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /409|conflict|already\s*exists/i.test(message);
}

function isRetriableMutateError(err: unknown): boolean {
  return isWriteConflict(err) || isTransientApiError(err);
}

/**
 * Read-modify-write `name`'s data with retry on both an optimistic-lock 409 and a
 * transient apiserver drop. The mutator edits the freshly-read data map in place
 * on each attempt, so a concurrent write that lands between our read and write is
 * merged rather than clobbered.
 */
export async function mutateConfigMap(
  name: string,
  mutator: (data: Record<string, string>) => void,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MUTATE_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(backoffDelayMs(attempt - 1));
    try {
      const state = await readConfigMapData(name);
      mutator(state.data);
      await writeConfigMapData(name, state);
      return;
    } catch (err) {
      lastErr = err;
      if (!isRetriableMutateError(err) || attempt === MUTATE_MAX_ATTEMPTS - 1) throw err;
    }
  }
  throw lastErr ?? new Error(`Failed to persist ConfigMap ${name}`);
}
