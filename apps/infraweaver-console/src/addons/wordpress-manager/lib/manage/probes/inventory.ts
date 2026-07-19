/**
 * Inventory panel probe — every plugin and theme installed on the site, read live
 * over `wp-cli`. No plugin gate: `plugin list` / `theme list` are core wp-cli.
 * The `slug` we expose is the wp-cli `name` (the wp.org/directory slug); we mark
 * `canAct` only when it passes the strict Manage action charset so the panel can
 * safely offer an update/activate/deactivate button for it and skip it otherwise.
 */
import { WP, parseJsonArray, fieldStr } from "../wp-probe";
import type { PanelProbe, PanelProbeContext } from "./contract";

/** Same charset the allow-listed Manage actions accept — a slug outside it is display-only. */
const SLUG_RE = /^[a-z0-9-]+$/;

export interface InventoryPlugin {
  readonly slug: string;
  readonly name: string;
  /** Raw wp-cli status: active | inactive | must-use | dropin | active-network. */
  readonly status: string;
  readonly active: boolean;
  readonly version: string | null;
  readonly updateAvailable: boolean;
  readonly updateVersion: string | null;
  readonly autoUpdate: boolean;
  /** True when the slug is safe to pass to an allow-listed action. */
  readonly canAct: boolean;
}

export interface InventoryTheme {
  readonly slug: string;
  readonly name: string;
  readonly status: string;
  readonly active: boolean;
  readonly version: string | null;
  readonly updateAvailable: boolean;
  readonly canAct: boolean;
}

export interface InventoryData {
  readonly plugins: readonly InventoryPlugin[];
  readonly themes: readonly InventoryTheme[];
  readonly activePlugins: number;
  readonly pluginUpdates: number;
  readonly themeUpdates: number;
}

type CliRow = {
  name?: string;
  title?: string;
  status?: string;
  version?: string;
  update?: string;
  update_version?: string;
  auto_update?: string;
};

function rowName(row: CliRow): string {
  return fieldStr(row, "title") ?? fieldStr(row, "name") ?? "unknown";
}

function isSafeSlug(slug: string): boolean {
  return slug !== "" && SLUG_RE.test(slug);
}

export function parseInventory(input: { plugins: string; themes: string }): InventoryData {
  const plugins: InventoryPlugin[] = parseJsonArray<CliRow>(input.plugins).map((row) => {
    const slug = fieldStr(row, "name") ?? "";
    const status = fieldStr(row, "status") ?? "inactive";
    return {
      slug,
      name: rowName(row),
      status,
      active: status === "active" || status === "active-network",
      version: fieldStr(row, "version"),
      updateAvailable: fieldStr(row, "update") === "available",
      updateVersion: fieldStr(row, "update_version"),
      autoUpdate: fieldStr(row, "auto_update") === "on",
      canAct: isSafeSlug(slug),
    };
  });

  const themes: InventoryTheme[] = parseJsonArray<CliRow>(input.themes).map((row) => {
    const slug = fieldStr(row, "name") ?? "";
    const status = fieldStr(row, "status") ?? "inactive";
    return {
      slug,
      name: rowName(row),
      status,
      active: status === "active",
      version: fieldStr(row, "version"),
      updateAvailable: fieldStr(row, "update") === "available",
      canAct: isSafeSlug(slug),
    };
  });

  return {
    plugins,
    themes,
    activePlugins: plugins.filter((p) => p.active).length,
    pluginUpdates: plugins.filter((p) => p.updateAvailable).length,
    themeUpdates: themes.filter((t) => t.updateAvailable).length,
  };
}

async function fetchInventory(ctx: PanelProbeContext): Promise<InventoryData> {
  const [plugins, themes] = await Promise.all([
    ctx
      .exec(`${WP} plugin list --format=json --fields=name,title,status,version,update,update_version,auto_update`)
      .then((r) => r.stdout)
      .catch(() => "[]"),
    ctx
      .exec(`${WP} theme list --format=json --fields=name,title,status,version,update`)
      .then((r) => r.stdout)
      .catch(() => "[]"),
  ]);

  return parseInventory({ plugins, themes });
}

export const inventoryProbe: PanelProbe<InventoryData> = {
  id: "inventory",
  fetch: fetchInventory,
};
