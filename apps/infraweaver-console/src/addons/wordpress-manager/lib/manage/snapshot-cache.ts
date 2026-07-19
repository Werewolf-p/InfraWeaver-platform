import "server-only";

/**
 * A small stale-while-revalidate cache for Manage-console reads. Every panel's
 * data is gathered by exec-ing wp-cli inside the site pod — cheap individually
 * but a visible wait on every tab open. This cache serves the last snapshot
 * instantly and refreshes it in the background, so a reopened tab (or a second
 * viewer on the same console replica) paints immediately instead of blocking on
 * a fresh round-trip. It is the read-through equivalent of scraping a site into a
 * metrics store: the console answers from the snapshot and reconciles behind it.
 *
 * Scope + honesty: this is a per-process cache (each console replica warms its
 * own; it does not survive a restart or span replicas). That is the right size
 * for "don't wait on reopen"; a shared/persistent store (e.g. a Prometheus
 * exporter for the numeric series, or a ConfigMap-backed snapshot) would be the
 * next step for cross-replica warmth and is deliberately left as a follow-up.
 */

interface CacheEntry<T> {
  value: T;
  at: number;
  refreshing: boolean;
}

/** A cached read plus its freshness, so the API can tell the client how old it is. */
export interface Cached<T> {
  readonly value: T;
  readonly cachedAt: number;
  readonly stale: boolean;
}

const STORE = new Map<string, CacheEntry<unknown>>();

/**
 * Read `key` through the cache. Fresh (< freshMs) ⇒ returned as-is. Stale but
 * present ⇒ returned instantly while a single background refresh runs. Absent ⇒
 * loaded synchronously (the only path that can throw — a failed background
 * refresh keeps the prior value and is swallowed, so a transient pod blip never
 * blanks a panel that already has data).
 */
export async function withCache<T>(
  key: string,
  freshMs: number,
  loader: () => Promise<T>,
): Promise<Cached<T>> {
  const now = Date.now();
  const entry = STORE.get(key) as CacheEntry<T> | undefined;

  if (entry && now - entry.at < freshMs) {
    return { value: entry.value, cachedAt: entry.at, stale: false };
  }

  if (entry) {
    if (!entry.refreshing) {
      entry.refreshing = true;
      void loader()
        .then((value) => STORE.set(key, { value, at: Date.now(), refreshing: false }))
        .catch(() => {
          entry.refreshing = false; // keep the stale value; try again next read
        });
    }
    return { value: entry.value, cachedAt: entry.at, stale: true };
  }

  const value = await loader();
  STORE.set(key, { value, at: Date.now(), refreshing: false });
  return { value, cachedAt: Date.now(), stale: false };
}

/** Drop every cached snapshot for a site — call after a mutation so the next read is fresh. */
export function invalidateManageCache(site: string): void {
  const prefix = `${site}::`;
  for (const key of STORE.keys()) {
    if (key.startsWith(prefix)) STORE.delete(key);
  }
}

export function overviewKey(site: string): string {
  return `${site}::overview`;
}

export function panelKey(site: string, panel: string): string {
  return `${site}::panel::${panel}`;
}
