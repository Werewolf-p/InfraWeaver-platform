import "server-only";
import { makeCoreApi } from "@/lib/kube-client";
import { isK8sNotFound, isTransientApiError } from "../k8s-errors";
import type { ManageOverview } from "./types";

/**
 * Durable, cross-replica snapshot store for the Manage-console overview.
 *
 * The per-replica SWR cache (snapshot-cache.ts) only spares a REOPENED tab on the
 * SAME console replica; a first hit — a cold pod, a new replica, a restart — still
 * blocks on three wp-cli execs. This store is the follow-up that doc header names:
 * one ConfigMap in the console namespace (`infraweaver-wp-manage-snapshots`),
 * keyed by site, holding the last overview each site answered. The hourly sweep
 * (site-sweep.ts) force-pulls every site and writes here; the page reads from here
 * and paints instantly, only ever touching wp-cli on an explicit force-renew or
 * when a site has never been swept.
 *
 * Same ConfigMap-backed, optimistic-concurrency pattern as iwsl-link-store /
 * access-store — human-inspectable via kubectl. Safe to persist in a ConfigMap:
 * the overview carries only versions, counts, capability booleans and connector
 * liveness — no secrets, no per-user data. Each entry is size-bounded and every
 * read validates the shape, so a corrupt or oversized value degrades to "no
 * snapshot" (a live pull) rather than throwing into the page path.
 */

const CONSOLE_NAMESPACE = process.env.CONSOLE_NAMESPACE ?? process.env.POD_NAMESPACE ?? "infraweaver-console";
const CONFIGMAP_NAME = process.env.WP_MANAGE_SNAPSHOTS_CONFIGMAP_NAME ?? "infraweaver-wp-manage-snapshots";

/** Serialization version — bumped if the stored shape ever changes incompatibly. */
const SNAPSHOT_VERSION = 1;

/**
 * Per-entry serialized-size ceiling. A single overview is ~1 KB; 16 KB is ample
 * headroom while still bounding a pathological value so one site can't blow the
 * ConfigMap's ~1 MB object limit. An entry over the cap is simply not written
 * (the previous good snapshot is kept), logged, never truncated into garbage.
 */
const MAX_ENTRY_BYTES = 16_384;

/** A parsed durable snapshot: the overview plus the epoch-ms it was captured. */
export interface StoredSiteSnapshot {
  readonly overview: ManageOverview;
  readonly at: number;
}

interface StoredEnvelope {
  v: number;
  at: number;
  overview: ManageOverview;
}

/** Serialize an overview + capture time into the stored JSON envelope. Pure. */
export function serializeSnapshot(overview: ManageOverview, at: number): string {
  const envelope: StoredEnvelope = { v: SNAPSHOT_VERSION, at, overview };
  return JSON.stringify(envelope);
}

/**
 * Parse one stored envelope back into a snapshot, or null when it is missing,
 * unparseable, the wrong version, or structurally invalid. Pure and total — it
 * never throws, so a single corrupt entry can never sink a read of the whole map.
 */
export function parseSnapshot(raw: string | undefined): StoredSiteSnapshot | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const env = parsed as Partial<StoredEnvelope>;
  if (env.v !== SNAPSHOT_VERSION) return null;
  if (typeof env.at !== "number" || !Number.isFinite(env.at)) return null;
  const overview = env.overview;
  if (typeof overview !== "object" || overview === null) return null;
  if (typeof (overview as ManageOverview).site !== "string") return null;
  if (!Array.isArray((overview as ManageOverview).panels)) return null;
  return { overview: overview as ManageOverview, at: env.at };
}

interface SnapshotsConfigMap {
  metadata?: { resourceVersion?: string };
  data?: Record<string, string | undefined>;
}

interface LoadedSnapshots {
  data: Record<string, string>;
  resourceVersion?: string;
}

async function readConfigMap(): Promise<LoadedSnapshots> {
  const core = makeCoreApi();
  try {
    const cm = (await core.readNamespacedConfigMap({
      name: CONFIGMAP_NAME,
      namespace: CONSOLE_NAMESPACE,
    })) as SnapshotsConfigMap;
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

async function writeConfigMap(state: LoadedSnapshots): Promise<void> {
  const core = makeCoreApi();
  const body = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: CONFIGMAP_NAME,
      namespace: CONSOLE_NAMESPACE,
      labels: {
        "app.kubernetes.io/managed-by": "infraweaver-console",
        "infraweaver.io/component": "wordpress",
      },
      ...(state.resourceVersion ? { resourceVersion: state.resourceVersion } : {}),
    },
    data: { ...state.data, updatedAt: new Date().toISOString() },
  };
  if (state.resourceVersion) {
    await core.replaceNamespacedConfigMap({ name: CONFIGMAP_NAME, namespace: CONSOLE_NAMESPACE, body });
  } else {
    await core.createNamespacedConfigMap({ namespace: CONSOLE_NAMESPACE, body });
  }
}

/** How many times a conflicting read-modify-write is retried (mirrors iwsl-link-store). */
const MUTATE_MAX_ATTEMPTS = 6;
const MUTATE_BACKOFF_BASE_MS = 25;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Full-jitter exponential backoff so lock-stepped sweep writers don't re-collide. */
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
 * Read-modify-write on the snapshot map with retry on both an optimistic-lock 409
 * and a transient apiserver drop. The mutator edits the reserved-key-free data
 * map in place on each fresh read, so a concurrent write that lands between our
 * read and write is merged, not clobbered (the sweep's per-site writes converge).
 */
async function mutateSnapshots(mutator: (data: Record<string, string>) => void): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MUTATE_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(backoffDelayMs(attempt - 1));
    try {
      const state = await readConfigMap();
      mutator(state.data);
      await writeConfigMap(state);
      return;
    } catch (err) {
      lastErr = err;
      if (!isRetriableMutateError(err) || attempt === MUTATE_MAX_ATTEMPTS - 1) throw err;
    }
  }
  throw lastErr ?? new Error("Failed to persist Manage snapshots");
}

/** Reserved data key carrying the ConfigMap's own write timestamp — never a site. */
const RESERVED_KEY = "updatedAt";

/** Read every site's durable snapshot, keyed by site. Corrupt entries are skipped. */
export async function readAllSnapshots(): Promise<Map<string, StoredSiteSnapshot>> {
  const { data } = await readConfigMap();
  const out = new Map<string, StoredSiteSnapshot>();
  for (const [site, raw] of Object.entries(data)) {
    if (site === RESERVED_KEY) continue;
    const snap = parseSnapshot(raw);
    if (snap) out.set(site, snap);
  }
  return out;
}

/** Read one site's durable snapshot, or null when absent/corrupt. */
export async function readSiteSnapshot(site: string): Promise<StoredSiteSnapshot | null> {
  const { data } = await readConfigMap();
  return parseSnapshot(data[site]);
}

/** Serialize an entry, or null when it is oversized (caller keeps the prior value). */
function encodeEntry(overview: ManageOverview, at: number): string | null {
  const raw = serializeSnapshot(overview, at);
  if (Buffer.byteLength(raw, "utf8") > MAX_ENTRY_BYTES) return null;
  return raw;
}

/** Upsert one site's durable snapshot (force-renew + cold-load warm path). */
export async function writeSiteSnapshot(site: string, overview: ManageOverview, at = Date.now()): Promise<void> {
  const raw = encodeEntry(overview, at);
  if (raw === null) {
    console.warn(`[wordpress] Manage snapshot for ${site} exceeds ${MAX_ENTRY_BYTES}B — not persisted`);
    return;
  }
  await mutateSnapshots((data) => {
    data[site] = raw;
  });
}

/** One site's overview to persist in a batch sweep write. */
export interface SnapshotWriteEntry {
  readonly site: string;
  readonly overview: ManageOverview;
}

/**
 * Upsert many sites' snapshots in ONE read-modify-write. The hourly sweep uses
 * this so a fleet refresh is a single ConfigMap write, not N contending writes —
 * the reason the sweep never thunders on the one object. Oversized entries are
 * skipped (their prior value stays), the rest are written.
 */
export async function writeSiteSnapshots(entries: readonly SnapshotWriteEntry[], at = Date.now()): Promise<void> {
  if (entries.length === 0) return;
  const encoded = entries
    .map((e) => ({ site: e.site, raw: encodeEntry(e.overview, at) }))
    .filter((e): e is { site: string; raw: string } => {
      if (e.raw === null) {
        console.warn(`[wordpress] Manage snapshot for ${e.site} exceeds ${MAX_ENTRY_BYTES}B — not persisted`);
        return false;
      }
      return true;
    });
  if (encoded.length === 0) return;
  await mutateSnapshots((data) => {
    for (const { site, raw } of encoded) data[site] = raw;
  });
}
