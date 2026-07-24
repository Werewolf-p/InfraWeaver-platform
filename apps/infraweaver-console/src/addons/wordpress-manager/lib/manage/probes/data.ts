/**
 * Database panel probe — per-table sizes, total database weight, autoloaded-option
 * weight and count, plus transient and revision counts, all read live over
 * core `wp-cli` (WP_SAFE, so a broken plugin can't sink a read-only DB query).
 * This is the READ-ONLY base layer of the fused Database cockpit — it works on
 * every tier and on old connectors. All mutations flow through the cockpit's
 * bounded, gated, preview-first signed `db.cleanup` engine, never this probe and
 * never a raw `wp db optimize` / purge-all-transients path (those are retired).
 */
import { WP_SAFE, kvLine, parseKv, parseJsonArray, toInt, toNum, fieldStr, fieldNum } from "../wp-probe";
import type { PanelProbe, PanelProbeContext } from "./contract";

/** Bytes in one MiB — used to normalise `db size --size_format=b` rows to MB. */
const BYTES_PER_MB = 1024 * 1024;

/**
 * Sum the length of every autoloaded option in KB, straight from the options
 * table. The table prefix comes from wp-cli itself (never external input), so the
 * command substitution is safe; no un-validated value reaches this command line.
 * Broadened past the legacy `'yes'` to also count WP 6.6+ autoload states.
 */
const AUTOLOAD_KB_CMD =
  `${WP_SAFE} db query "SELECT ROUND(SUM(LENGTH(option_value))/1024,2) FROM ` +
  `$(${WP_SAFE} db prefix)options WHERE autoload IN ('yes','on','auto','auto-on')" --skip-column-names`;

export interface DbTable {
  readonly name: string;
  readonly sizeMb: number;
}

export interface DataPanelData {
  /** Whole-database size in MB, or null when unreadable. */
  readonly totalMb: number | null;
  /** Per-table sizes, largest first. */
  readonly tables: readonly DbTable[];
  /** Autoloaded-option weight in KB, or null when the query returned no rows. */
  readonly autoloadKb: number | null;
  /** Number of autoloaded options. */
  readonly autoloadCount: number;
  readonly transients: number;
  readonly revisions: number;
}

/** wp-cli `db size --tables` row. Declared as a `type` so it stays assignable to Record. */
type TableRow = {
  Name?: string;
  Size?: string | number;
};

export function parseData(input: { counts: string; tables: string; autoloadKb: string }): DataPanelData {
  const kv = parseKv(input.counts);

  const tables: DbTable[] = parseJsonArray<TableRow>(input.tables)
    .map((row) => {
      const bytes = fieldNum(row, "Size") ?? 0;
      return {
        name: fieldStr(row, "Name") ?? "(unknown)",
        sizeMb: Math.round((bytes / BYTES_PER_MB) * 100) / 100,
      };
    })
    .sort((a, b) => b.sizeMb - a.sizeMb);

  return {
    totalMb: toNum(kv.get("DB_TOTAL_MB")),
    tables,
    autoloadKb: toNum(input.autoloadKb),
    autoloadCount: toInt(kv.get("AUTOLOAD_COUNT")) ?? 0,
    transients: toInt(kv.get("TRANSIENTS")) ?? 0,
    revisions: toInt(kv.get("REVISIONS")) ?? 0,
  };
}

async function fetchData(ctx: PanelProbeContext): Promise<DataPanelData> {
  const countsCmd = [
    kvLine("DB_TOTAL_MB", `${WP_SAFE} db size --size_format=mb`),
    kvLine("AUTOLOAD_COUNT", `${WP_SAFE} option list --autoload=on --format=count`),
    kvLine("TRANSIENTS", `${WP_SAFE} transient list --format=count`),
    kvLine("REVISIONS", `${WP_SAFE} post list --post_type=revision --format=count`),
  ].join("\n");

  const [counts, tables, autoloadKb] = await Promise.all([
    ctx.exec(countsCmd).then((r) => r.stdout).catch(() => ""),
    ctx
      .exec(`${WP_SAFE} db size --tables --size_format=b --format=json`)
      .then((r) => r.stdout)
      .catch(() => "[]"),
    ctx.exec(AUTOLOAD_KB_CMD).then((r) => r.stdout).catch(() => ""),
  ]);

  return parseData({ counts, tables, autoloadKb });
}

export const dataProbe: PanelProbe<DataPanelData> = {
  id: "data",
  fetch: fetchData,
};
