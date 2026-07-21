import { promises as fs } from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";

/**
 * Package the vendored InfraWeaver Connector plugin (vendor/wp-connector/,
 * see scripts/sync-wp-connector.sh) as the standard WordPress plugin zip:
 * every file under a single `infraweaver-connector/` root, which is both what
 * wp-admin's uploader and `wp plugin install <zip>` expect.
 *
 * Serves two consumers: the external-sites "Download plugin" route, and
 * managed enrollment (which streams the same bytes into a site pod). The
 * archive is built once and cached — inside the image the files can never
 * change for the life of the process.
 */

const PLUGIN_DIR_NAME = "infraweaver-connector";

export interface ConnectorPackage {
  zip: Buffer;
  version: string;
  filename: string;
}

/** The always-present copy baked into the image (the safe fallback). */
function bakedDir(): string {
  return path.join(process.cwd(), "vendor", "wp-connector", PLUGIN_DIR_NAME);
}

/** A dir is a usable plugin source only if it holds the plugin header file. */
async function isValidPluginDir(dir: string): Promise<boolean> {
  return fs
    .stat(path.join(dir, `${PLUGIN_DIR_NAME}.php`))
    .then((s) => s.isFile())
    .catch(() => false);
}

/**
 * Resolve the plugin source. Prefer IWSL_CONNECTOR_DIR (e.g. a git-sync sidecar
 * volume) when it currently holds a valid plugin; otherwise fall back to the
 * baked vendor copy. This makes the dynamic source fail-safe: a missing or
 * mid-swap sync dir degrades to the baked copy instead of breaking the route.
 */
async function resolveDir(): Promise<string> {
  const override = process.env.IWSL_CONNECTOR_DIR;
  if (override && (await isValidPluginDir(override))) {
    return override;
  }
  return bakedDir();
}

/** Cheap version peek from the plugin header — used as the cache key. */
async function peekVersion(dir: string): Promise<string> {
  const header = await fs
    .readFile(path.join(dir, `${PLUGIN_DIR_NAME}.php`), "utf8")
    .catch(() => "");
  return parseVersion(header);
}

async function collectFiles(root: string, rel = ""): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await collectFiles(root, entryRel)));
    else if (entry.isFile()) files.push(entryRel);
  }
  return files.sort();
}

/** The `Version:` value from the plugin header; "0.0.0" if unreadable. */
function parseVersion(headerFile: string): string {
  const match = headerFile.match(/^\s*\*?\s*Version:\s*([0-9][\w.-]*)\s*$/m);
  return match ? match[1] : "0.0.0";
}

let cached: { key: string; pkg: Promise<ConnectorPackage> } | null = null;

async function build(root: string): Promise<ConnectorPackage> {
  const exists = await fs.stat(root).then((s) => s.isDirectory()).catch(() => false);
  if (!exists) {
    throw new Error(
      `vendored connector plugin not found at ${root} — run scripts/sync-wp-connector.sh (is vendor/ in the image?)`,
    );
  }
  const files = await collectFiles(root);
  const tree: Record<string, Uint8Array> = {};
  for (const rel of files) {
    tree[`${PLUGIN_DIR_NAME}/${rel}`] = new Uint8Array(await fs.readFile(path.join(root, rel)));
  }
  const header = await fs.readFile(path.join(root, `${PLUGIN_DIR_NAME}.php`), "utf8").catch(() => "");
  const version = parseVersion(header);
  return {
    zip: Buffer.from(zipSync(tree, { level: 9 })),
    version,
    filename: `${PLUGIN_DIR_NAME}-${version}.zip`,
  };
}

export async function buildConnectorPackage(): Promise<ConnectorPackage> {
  const root = await resolveDir();
  const version = await peekVersion(root);
  const key = `${root}@${version}`;
  // Re-zip only when the resolved source or its version changes — so a git-sync
  // update goes live without a restart, but a steady source stays fully cached.
  if (cached && cached.key === key) {
    return cached.pkg;
  }
  const pkg = build(root).catch((err) => {
    // Don't cache a failure — a missing dir at first call (e.g. mid-deploy or a
    // mid-swap sync) must not brick the route until restart.
    if (cached && cached.key === key) {
      cached = null;
    }
    throw err;
  });
  cached = { key, pkg };
  return pkg;
}

/** Test hook — the cache is process-wide by design. */
export function __resetConnectorPackageCache(): void {
  cached = null;
}
