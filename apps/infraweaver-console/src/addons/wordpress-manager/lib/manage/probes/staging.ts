/**
 * Staging & Deploys panel probe — WP Staging clones read live from the plugin's
 * own option store (gated on the `staging` capability). WP Staging keeps its clone
 * registry in `wpstg_existing_clones_beta` (newer, an object of rich records) or
 * `wpstg_existing_clones` (legacy, an object of records or a bare array of
 * directory names). We read whichever is present and normalise each clone. There
 * is no allow-listed clone/deploy action, so the panel renders no buttons.
 */
import { WP_SAFE, parseJsonArray, parseJsonObject, fieldStr, fieldNum } from "../wp-probe";
import type { PanelProbe, PanelProbeContext } from "./contract";

export interface StagingClone {
  readonly name: string;
  readonly path: string | null;
  readonly url: string | null;
  readonly dbname: string | null;
  readonly prefix: string | null;
  readonly status: string | null;
  /** Clone creation time (ISO8601 when derivable), or the raw value, or null. */
  readonly datetime: string | null;
}

export interface StagingData {
  readonly clones: readonly StagingClone[];
}

/** One WP Staging clone record — every field optional, present-set varies by version. */
type CloneRow = {
  cloneName?: unknown;
  directoryName?: unknown;
  path?: unknown;
  url?: unknown;
  databaseDatabase?: unknown;
  prefix?: unknown;
  status?: unknown;
  datetime?: unknown;
};

/** Narrow an unknown option value to a plain object row, or null. */
function toRow(value: unknown): CloneRow | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as CloneRow) : null;
}

/** Normalise one clone record; `datetime` is epoch-seconds in some versions, a formatted string in others. */
function normalizeClone(key: string, row: CloneRow): StagingClone {
  const epoch = fieldNum(row, "datetime");
  const datetime = epoch !== null ? new Date(epoch * 1000).toISOString() : fieldStr(row, "datetime");
  return {
    name: fieldStr(row, "cloneName") ?? fieldStr(row, "directoryName") ?? key,
    path: fieldStr(row, "path"),
    url: fieldStr(row, "url"),
    dbname: fieldStr(row, "databaseDatabase"),
    prefix: fieldStr(row, "prefix"),
    status: fieldStr(row, "status"),
    datetime,
  };
}

/** Read clones from an option shaped as `{ slug: record, … }`. */
function clonesFromObject(stdout: string): StagingClone[] {
  const obj = parseJsonObject<Record<string, unknown>>(stdout);
  if (!obj) return [];
  const clones: StagingClone[] = [];
  for (const [key, value] of Object.entries(obj)) {
    const row = toRow(value);
    if (row) clones.push(normalizeClone(key, row));
  }
  return clones;
}

export function parseStaging(input: { beta: string; legacy: string }): StagingData {
  const beta = clonesFromObject(input.beta);
  if (beta.length > 0) return { clones: beta };

  // Legacy key: either an object of records, or a bare array of directory names.
  const legacyObj = clonesFromObject(input.legacy);
  if (legacyObj.length > 0) return { clones: legacyObj };

  const names = parseJsonArray<unknown>(input.legacy).filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  const clones = names.map<StagingClone>((name) => ({
    name,
    path: null,
    url: null,
    dbname: null,
    prefix: null,
    status: null,
    datetime: null,
  }));
  return { clones };
}

async function fetchStaging(ctx: PanelProbeContext): Promise<StagingData> {
  const [beta, legacy] = await Promise.all([
    ctx.exec(`${WP_SAFE} option get wpstg_existing_clones_beta --format=json`).then((r) => r.stdout).catch(() => ""),
    ctx.exec(`${WP_SAFE} option get wpstg_existing_clones --format=json`).then((r) => r.stdout).catch(() => ""),
  ]);
  return parseStaging({ beta, legacy });
}

export const stagingProbe: PanelProbe<StagingData> = {
  id: "staging",
  requiresCapability: "staging",
  fetch: fetchStaging,
};
