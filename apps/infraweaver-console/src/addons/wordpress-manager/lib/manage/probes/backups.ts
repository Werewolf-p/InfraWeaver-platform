/**
 * Backups panel probe — backup posture read live from whichever backup plugin the
 * site runs (gated on the `backups` capability). UpdraftPlus exposes a rich option
 * surface — last-backup record, file interval, retention count — which we read
 * directly; other backup plugins (BackWPup, Duplicator, …) are only reported as
 * active. Everything is read-only: there is no allow-listed "run backup" action, so
 * the panel renders no mutation buttons.
 */
import { WP, WP_SAFE, kvLine, parseKv, parseJsonArray, parseJsonObject, toInt, toStr, fieldStr, fieldNum } from "../wp-probe";
import { BACKUP_PLUGIN_SLUGS } from "../capabilities";
import type { PanelProbe, PanelProbeContext } from "./contract";

/** The one backup plugin whose options we can introspect in detail. */
const UPDRAFT_SLUG = "updraftplus";

export interface BackupFile {
  readonly file: string;
  readonly mb: number;
}

export interface BackupsData {
  /** Active backup plugin slug (from BACKUP_PLUGIN_SLUGS), or null if none matched. */
  readonly plugin: string | null;
  /** True when UpdraftPlus is the active plugin — the only rich read path. */
  readonly updraft: boolean;
  /** File backup interval (e.g. "daily", "manual"), raw from `updraft_interval`, or null. */
  readonly schedule: string | null;
  /** Number of backup sets retained (`updraft_retain`), or null when unknown. */
  readonly retainSets: number | null;
  /** Last recorded backup timestamp (ISO8601), or null. */
  readonly lastBackupAt: string | null;
  /** Whether the last recorded backup reported no errors, or null when unknown. */
  readonly lastBackupOk: boolean | null;
  /** On-disk backup archives with sizes, largest first. */
  readonly files: readonly BackupFile[];
  /** Total size of stored backups in MB, or null when unreadable. */
  readonly totalMb: number | null;
}

/** UpdraftPlus stores its last-backup summary as a JSON object under one option. */
type LastBackupRow = {
  backup_time?: unknown;
  errors?: unknown;
};

/** Find the first active plugin whose slug is in `slugs`, lowercased-matched. */
async function detectActivePlugin(ctx: PanelProbeContext, slugs: readonly string[]): Promise<string | null> {
  const stdout = await ctx
    .exec(`${WP} plugin list --status=active --field=name --format=json`)
    .then((r) => r.stdout)
    .catch(() => "[]");
  const active = new Set(
    parseJsonArray<{ name?: string }>(stdout)
      .map((row) => fieldStr(row, "name")?.toLowerCase())
      .filter((name): name is string => Boolean(name)),
  );
  return slugs.find((slug) => active.has(slug)) ?? null;
}

/** Parse UpdraftPlus' `updraft_last_backup` object into a timestamp + success flag. */
function parseLastBackup(stdout: string): { at: string | null; ok: boolean | null } {
  const obj = parseJsonObject<LastBackupRow>(stdout);
  if (!obj) return { at: null, ok: null };
  const epoch = fieldNum(obj, "backup_time");
  const at = epoch !== null ? new Date(epoch * 1000).toISOString() : null;
  const errs = obj.errors;
  const ok = Array.isArray(errs) ? errs.length === 0 : null;
  return { at, ok };
}

/** Parse `du -m` lines (`<mb>\t<path>`) into the largest backup archives. */
function parseFiles(stdout: string): BackupFile[] {
  const files: BackupFile[] = [];
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const mb = Number(match[1]);
    if (!Number.isFinite(mb)) continue;
    const file = match[2].split("/").filter(Boolean).pop() ?? match[2];
    files.push({ file, mb });
  }
  return files;
}

export function parseBackups(input: {
  plugin: string | null;
  scalars: string;
  lastBackup: string;
  files: string;
}): BackupsData {
  const updraft = input.plugin === UPDRAFT_SLUG;
  if (!updraft) {
    return {
      plugin: input.plugin,
      updraft: false,
      schedule: null,
      retainSets: null,
      lastBackupAt: null,
      lastBackupOk: null,
      files: [],
      totalMb: null,
    };
  }

  const kv = parseKv(input.scalars);
  const { at, ok } = parseLastBackup(input.lastBackup);

  return {
    plugin: input.plugin,
    updraft: true,
    schedule: toStr(kv.get("SCHEDULE")),
    retainSets: toInt(kv.get("RETAIN")),
    lastBackupAt: at,
    lastBackupOk: ok,
    files: parseFiles(input.files),
    totalMb: toInt(kv.get("TOTAL_MB")),
  };
}

async function fetchBackups(ctx: PanelProbeContext): Promise<BackupsData> {
  const plugin = await detectActivePlugin(ctx, BACKUP_PLUGIN_SLUGS);

  // Only UpdraftPlus exposes a readable option surface; for anything else we report
  // the plugin as active without inventing schedule/restore data it doesn't publish.
  if (plugin !== UPDRAFT_SLUG) {
    return parseBackups({ plugin, scalars: "", lastBackup: "", files: "" });
  }

  const scalarsCmd = [
    kvLine("SCHEDULE", `${WP_SAFE} option get updraft_interval`),
    kvLine("RETAIN", `${WP_SAFE} option get updraft_retain`),
    kvLine("TOTAL_MB", `du -sm wp-content/updraft 2>/dev/null | cut -f1`),
  ].join("\n");

  const [scalars, lastBackup, files] = await Promise.all([
    ctx.exec(scalarsCmd).then((r) => r.stdout).catch(() => ""),
    ctx.exec(`${WP_SAFE} option get updraft_last_backup --format=json`).then((r) => r.stdout).catch(() => ""),
    ctx.exec(`du -m wp-content/updraft/* 2>/dev/null | sort -rn | head -12`).then((r) => r.stdout).catch(() => ""),
  ]);

  return parseBackups({ plugin, scalars, lastBackup, files });
}

export const backupsProbe: PanelProbe<BackupsData> = {
  id: "backups",
  requiresCapability: "backups",
  fetch: fetchBackups,
};
