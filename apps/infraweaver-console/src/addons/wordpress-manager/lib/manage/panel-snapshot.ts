import "server-only";
import { assertValidSiteId } from "../naming";
import { isManagePanelId, type ManagePanelId } from "./capabilities";
import { mutateConfigMap, readConfigMapData, RESERVED_UPDATED_AT_KEY } from "./configmap-store";

/**
 * Durable, cross-replica snapshot store for the Manage console's PER-PANEL data —
 * the sibling of site-snapshot.ts (which holds only the header overview). The
 * hourly sweep captures every AVAILABLE panel's data per site into here; a panel
 * read then serves durable-first and paints instantly, only touching wp-cli on an
 * explicit force-renew or when a panel has never been swept.
 *
 * STORAGE MODEL — deliberately ONE ConfigMap PER SITE
 * (`infraweaver-wp-manage-panels-<site>`), keyed by panel id, NOT one shared map.
 * A ConfigMap's hard object limit is ~1 MB; a site can have ~22 panels. Sharding
 * per site keeps each object to at most (panels × MAX_PANEL_ENTRY_BYTES) ≈
 * 22 × 16 KB ≈ 350 KB — comfortably under the limit — and means one busy site
 * never crowds out another's snapshots.
 *
 * PER-PANEL BOUND — each panel's serialized entry is capped at
 * MAX_PANEL_ENTRY_BYTES (16 KB). List-heavy panels (media, content, users,
 * comments) MUST bound their own rows at the probe (store the first N + exact
 * totals, live-fetch more on demand) so their snapshot fits; a panel whose entry
 * still exceeds the cap is simply NOT persisted (it live-fetches on open) rather
 * than truncated into garbage. No structured/high-cardinality data ever leaves
 * this ConfigMap for Prometheus — the numeric KPI gauges live in site-kpis.ts and
 * carry only counts/scalars.
 *
 * Same optimistic-concurrency ConfigMap machinery (configmap-store.ts) as the
 * overview store, human-inspectable via kubectl. Every read validates the shape,
 * so a corrupt/oversized value degrades to "no snapshot" (a live pull) instead of
 * throwing into the page path.
 */

const CONFIGMAP_PREFIX =
  process.env.WP_MANAGE_PANEL_SNAPSHOTS_CONFIGMAP_PREFIX ?? "infraweaver-wp-manage-panels";

/** Serialization version — bumped if the stored envelope shape changes incompatibly. */
const PANEL_SNAPSHOT_VERSION = 1;

/**
 * Per-panel serialized-size ceiling (16 KB). Ample for a bounded panel payload
 * while capping a pathological value so one panel can't push a per-site ConfigMap
 * toward the ~1 MB object limit. An entry over the cap is not written (the prior
 * good snapshot is kept), logged, never truncated.
 */
export const MAX_PANEL_ENTRY_BYTES = 16_384;

/** RFC1123 subdomain — the shape a ConfigMap name must satisfy. */
const RFC1123_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** The per-site ConfigMap holding that site's panel snapshots. */
function panelConfigMapName(site: string): string {
  assertValidSiteId(site);
  const name = `${CONFIGMAP_PREFIX}-${site}`;
  if (name.length > 253 || !RFC1123_NAME_RE.test(name)) {
    throw new Error(`refusing invalid panel-snapshot ConfigMap name: ${JSON.stringify(name)}`);
  }
  return name;
}

/** A parsed durable panel snapshot: the panel's data plus the epoch-ms it was captured. */
export interface StoredPanelSnapshot {
  readonly panel: ManagePanelId;
  readonly data: unknown;
  readonly at: number;
}

interface PanelEnvelope {
  v: number;
  at: number;
  panel: ManagePanelId;
  data: unknown;
}

/** Serialize one panel's data + capture time into the stored JSON envelope. Pure. */
export function serializePanelSnapshot(panel: ManagePanelId, data: unknown, at: number): string {
  const envelope: PanelEnvelope = { v: PANEL_SNAPSHOT_VERSION, at, panel, data };
  return JSON.stringify(envelope);
}

/**
 * Parse one stored panel envelope, or null when missing, unparseable, the wrong
 * version, or structurally invalid. Pure and total — never throws, so a single
 * corrupt entry can never sink a read of the whole map.
 */
export function parsePanelSnapshot(raw: string | undefined): StoredPanelSnapshot | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const env = parsed as Partial<PanelEnvelope>;
  if (env.v !== PANEL_SNAPSHOT_VERSION) return null;
  if (typeof env.at !== "number" || !Number.isFinite(env.at)) return null;
  if (typeof env.panel !== "string" || !isManagePanelId(env.panel)) return null;
  if (!("data" in env)) return null;
  return { panel: env.panel, data: env.data, at: env.at };
}

/** Serialize an entry, or null when it is oversized (caller keeps the prior value). */
function encodePanelEntry(panel: ManagePanelId, data: unknown, at: number): string | null {
  const raw = serializePanelSnapshot(panel, data, at);
  if (Buffer.byteLength(raw, "utf8") > MAX_PANEL_ENTRY_BYTES) return null;
  return raw;
}

/** Read one site+panel durable snapshot, or null when absent/corrupt. */
export async function readSitePanelSnapshot(
  site: string,
  panel: string,
): Promise<StoredPanelSnapshot | null> {
  if (!isManagePanelId(panel)) return null;
  const { data } = await readConfigMapData(panelConfigMapName(site));
  return parsePanelSnapshot(data[panel]);
}

/** Read every panel snapshot for a site, keyed by panel id. Corrupt entries are skipped. */
export async function readSitePanelSnapshots(site: string): Promise<Map<ManagePanelId, StoredPanelSnapshot>> {
  const { data } = await readConfigMapData(panelConfigMapName(site));
  const out = new Map<ManagePanelId, StoredPanelSnapshot>();
  for (const [key, raw] of Object.entries(data)) {
    if (key === RESERVED_UPDATED_AT_KEY) continue;
    const snap = parsePanelSnapshot(raw);
    if (snap) out.set(snap.panel, snap);
  }
  return out;
}

/** Upsert one panel's durable snapshot for a site (force-renew + cold-load warm path). */
export async function writeSitePanelSnapshot(
  site: string,
  panel: ManagePanelId,
  data: unknown,
  at = Date.now(),
): Promise<void> {
  const raw = encodePanelEntry(panel, data, at);
  if (raw === null) {
    console.warn(`[wordpress] Manage panel snapshot ${site}/${panel} exceeds ${MAX_PANEL_ENTRY_BYTES}B — not persisted`);
    return;
  }
  await mutateConfigMap(panelConfigMapName(site), (map) => {
    map[panel] = raw;
  });
}

/** One panel's data to persist in a batch sweep write. */
export interface PanelSnapshotWriteEntry {
  readonly panel: ManagePanelId;
  readonly data: unknown;
}

/**
 * Upsert many of a site's panel snapshots in ONE read-modify-write, so the hourly
 * sweep persists a site's whole panel set as a single ConfigMap write rather than
 * N contending writes. Oversized entries are skipped (their prior value stays);
 * the rest are written. An empty batch is a no-op (no I/O).
 */
export async function writeSitePanelSnapshots(
  site: string,
  entries: readonly PanelSnapshotWriteEntry[],
  at = Date.now(),
): Promise<void> {
  if (entries.length === 0) return;
  const encoded = entries
    .map((e) => ({ panel: e.panel, raw: encodePanelEntry(e.panel, e.data, at) }))
    .filter((e): e is { panel: ManagePanelId; raw: string } => {
      if (e.raw === null) {
        console.warn(`[wordpress] Manage panel snapshot ${site}/${e.panel} exceeds ${MAX_PANEL_ENTRY_BYTES}B — not persisted`);
        return false;
      }
      return true;
    });
  if (encoded.length === 0) return;
  await mutateConfigMap(panelConfigMapName(site), (map) => {
    for (const { panel, raw } of encoded) map[panel] = raw;
  });
}
