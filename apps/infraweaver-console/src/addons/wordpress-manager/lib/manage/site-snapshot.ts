import "server-only";
import { mutateConfigMap, readConfigMapData, RESERVED_UPDATED_AT_KEY } from "./configmap-store";
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

/** Read every site's durable snapshot, keyed by site. Corrupt entries are skipped. */
export async function readAllSnapshots(): Promise<Map<string, StoredSiteSnapshot>> {
  const { data } = await readConfigMapData(CONFIGMAP_NAME);
  const out = new Map<string, StoredSiteSnapshot>();
  for (const [site, raw] of Object.entries(data)) {
    if (site === RESERVED_UPDATED_AT_KEY) continue;
    const snap = parseSnapshot(raw);
    if (snap) out.set(site, snap);
  }
  return out;
}

/** Read one site's durable snapshot, or null when absent/corrupt. */
export async function readSiteSnapshot(site: string): Promise<StoredSiteSnapshot | null> {
  const { data } = await readConfigMapData(CONFIGMAP_NAME);
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
  await mutateConfigMap(CONFIGMAP_NAME, (data) => {
    data[site] = raw;
  });
}

/**
 * Drop one site's durable overview snapshot — call after a write action so the next
 * overview read pulls live and reflects the just-changed plugin/user/content state
 * (the header counts + capability booleans) instead of the pre-mutation snapshot.
 * Reads first and skips the write when the site has no stored overview, so it never
 * touches the ConfigMap needlessly.
 */
export async function clearSiteSnapshot(site: string): Promise<void> {
  const { data } = await readConfigMapData(CONFIGMAP_NAME);
  if (!(site in data)) return;
  await mutateConfigMap(CONFIGMAP_NAME, (map) => {
    delete map[site];
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
  await mutateConfigMap(CONFIGMAP_NAME, (data) => {
    for (const { site, raw } of encoded) data[site] = raw;
  });
}
