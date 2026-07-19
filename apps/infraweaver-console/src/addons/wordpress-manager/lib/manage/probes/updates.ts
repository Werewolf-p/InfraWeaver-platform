/**
 * Updates panel probe — WordPress core, plugin and theme updates read live from
 * the site via `wp-cli`. No plugin gate: core wp-cli always answers these.
 */
import { WP, WP_SAFE, parseJsonArray, parseKv, toStr, fieldStr } from "../wp-probe";
import type { PanelProbe, PanelProbeContext } from "./contract";

export type UpdateKind = "core" | "plugin" | "theme";

export interface UpdateComponent {
  readonly kind: UpdateKind;
  readonly slug: string;
  readonly name: string;
  readonly from: string;
  readonly to: string;
}

export interface UpdatesData {
  readonly core: {
    readonly current: string | null;
    readonly latest: string | null;
    readonly upToDate: boolean;
    readonly php: string | null;
  };
  readonly components: readonly UpdateComponent[];
  /** Plugins with WordPress auto-updates enabled. */
  readonly autoUpdatePlugins: number;
  readonly totalPlugins: number;
}

type CliRow = {
  name?: string;
  title?: string;
  version?: string;
  update_version?: string;
  auto_update?: string;
};

function rowName(row: CliRow): string {
  return fieldStr(row, "title") ?? fieldStr(row, "name") ?? "unknown";
}

export function parseUpdates(input: {
  scalars: string;
  core: string;
  plugins: string;
  themes: string;
  allPlugins: string;
}): UpdatesData {
  const kv = parseKv(input.scalars);
  const current = toStr(kv.get("WP_VERSION"));
  const php = toStr(kv.get("PHP_VERSION"));

  const coreRows = parseJsonArray<CliRow>(input.core);
  const latest = coreRows.length > 0 ? fieldStr(coreRows[0], "version") : null;
  const upToDate = coreRows.length === 0;

  const components: UpdateComponent[] = [];
  if (!upToDate && current && latest) {
    components.push({ kind: "core", slug: "wordpress", name: "WordPress core", from: current, to: latest });
  }
  for (const row of parseJsonArray<CliRow>(input.plugins)) {
    components.push({
      kind: "plugin",
      slug: fieldStr(row, "name") ?? "",
      name: rowName(row),
      from: fieldStr(row, "version") ?? "—",
      to: fieldStr(row, "update_version") ?? "—",
    });
  }
  for (const row of parseJsonArray<CliRow>(input.themes)) {
    components.push({
      kind: "theme",
      slug: fieldStr(row, "name") ?? "",
      name: rowName(row),
      from: fieldStr(row, "version") ?? "—",
      to: fieldStr(row, "update_version") ?? "—",
    });
  }

  const all = parseJsonArray<CliRow>(input.allPlugins);
  const autoUpdatePlugins = all.filter((row) => fieldStr(row, "auto_update") === "on").length;

  return {
    core: { current, latest, upToDate, php },
    components,
    autoUpdatePlugins,
    totalPlugins: all.length,
  };
}

async function fetchUpdates(ctx: PanelProbeContext): Promise<UpdatesData> {
  const scalarsCmd = [
    `echo "WP_VERSION=$(${WP_SAFE} core version 2>/dev/null)"`,
    `echo "PHP_VERSION=$(php -r 'echo PHP_VERSION;' 2>/dev/null)"`,
  ].join("\n");

  const [scalars, core, plugins, themes, allPlugins] = await Promise.all([
    ctx.exec(scalarsCmd).then((r) => r.stdout).catch(() => ""),
    ctx.exec(`${WP_SAFE} core check-update --format=json`).then((r) => r.stdout).catch(() => "[]"),
    ctx
      .exec(`${WP} plugin list --update=available --format=json --fields=name,title,version,update_version`)
      .then((r) => r.stdout)
      .catch(() => "[]"),
    ctx
      .exec(`${WP} theme list --update=available --format=json --fields=name,title,version,update_version`)
      .then((r) => r.stdout)
      .catch(() => "[]"),
    ctx
      .exec(`${WP} plugin list --format=json --fields=name,auto_update`)
      .then((r) => r.stdout)
      .catch(() => "[]"),
  ]);

  return parseUpdates({ scalars, core, plugins, themes, allPlugins });
}

export const updatesProbe: PanelProbe<UpdatesData> = {
  id: "updates",
  fetch: fetchUpdates,
};
