// Pluggable durable-storage seam for the audit trail.
//
// The store owns all ring-buffer + hash-chain logic and treats a sink as a dumb
// versioned array of JSON lines. This keeps a future Loki/S3 WORM sink a pure
// drop-in (implement read/write) without touching call sites or chain logic.

// NOTE: the k8s client (`@/lib/kube-client` → `@kubernetes/client-node`, ESM-only)
// is imported dynamically inside read/write so the audit store's import graph
// stays free of it — the store is then unit-testable with an in-memory sink
// (jest does not transform that ESM package), and production pays the import
// only when a durable read/write actually happens.

/** A point-in-time read of the durable log plus its optimistic-concurrency token. */
export interface AuditSnapshot {
  /** Non-empty JSON lines, oldest first. */
  lines: string[];
  /** Backend version token (k8s resourceVersion) for compare-and-swap writes. */
  version?: string;
}

export interface AuditSink {
  read(): Promise<AuditSnapshot>;
  /** Persist the full line array. Throws {@link AuditConflictError} if `version` is stale. */
  write(lines: string[], version?: string): Promise<void>;
}

/** Raised by a sink when a compare-and-swap write loses to a concurrent writer. */
export class AuditConflictError extends Error {
  constructor(message = "audit store version conflict") {
    super(message);
    this.name = "AuditConflictError";
  }
}

const NAMESPACE = "infraweaver-console";
const CONFIGMAP_NAME = "infra-console-audit-log";
const LOG_KEY = "log";
const HTTP_CONFLICT = 409;
const HTTP_NOT_FOUND = 404;

function statusOf(error: unknown): number | undefined {
  const candidate = error as { statusCode?: number; code?: number; response?: { statusCode?: number } } | null;
  return candidate?.statusCode ?? candidate?.code ?? candidate?.response?.statusCode;
}

function splitLog(log: string): string[] {
  return log.split("\n").filter(Boolean);
}

/**
 * ConfigMap-backed sink using the already-provisioned `infra-console-audit-log`
 * object. Reads carry the resourceVersion; writes use `replace` with that
 * version so a stale write is rejected (409) rather than silently clobbering a
 * concurrent writer — the store then re-reads and retries.
 */
export function createConfigMapSink(): AuditSink {
  return {
    async read(): Promise<AuditSnapshot> {
      const { makeCoreApi } = await import("@/lib/kube-client");
      const coreApi = makeCoreApi();
      try {
        const cm = (await coreApi.readNamespacedConfigMap({ name: CONFIGMAP_NAME, namespace: NAMESPACE })) as {
          data?: Record<string, string>;
          metadata?: { resourceVersion?: string };
        };
        return {
          lines: splitLog(cm.data?.[LOG_KEY] ?? ""),
          version: cm.metadata?.resourceVersion,
        };
      } catch (error) {
        if (statusOf(error) === HTTP_NOT_FOUND) return { lines: [] };
        throw error;
      }
    },

    async write(lines: string[], version?: string): Promise<void> {
      const { makeCoreApi } = await import("@/lib/kube-client");
      const coreApi = makeCoreApi();
      const body = `${lines.join("\n")}\n`;

      if (version === undefined) {
        // No known object yet — create it, tolerating a create/replace race.
        try {
          await coreApi.createNamespacedConfigMap({
            namespace: NAMESPACE,
            body: {
              metadata: { name: CONFIGMAP_NAME, namespace: NAMESPACE },
              data: { [LOG_KEY]: body },
            },
          });
          return;
        } catch (error) {
          if (statusOf(error) === HTTP_CONFLICT) throw new AuditConflictError();
          throw error;
        }
      }

      try {
        await coreApi.replaceNamespacedConfigMap({
          name: CONFIGMAP_NAME,
          namespace: NAMESPACE,
          body: {
            metadata: { name: CONFIGMAP_NAME, namespace: NAMESPACE, resourceVersion: version },
            data: { [LOG_KEY]: body },
          },
        });
      } catch (error) {
        if (statusOf(error) === HTTP_CONFLICT) throw new AuditConflictError();
        throw error;
      }
    },
  };
}

let _defaultSink: AuditSink | null = null;

/** Env-selectable durable sink. Defaults to the ConfigMap ring buffer. */
export function getAuditSink(): AuditSink {
  if (_defaultSink) return _defaultSink;
  // AUDIT_SINK is a seam for a future external WORM sink; only "configmap" today.
  _defaultSink = createConfigMapSink();
  return _defaultSink;
}
