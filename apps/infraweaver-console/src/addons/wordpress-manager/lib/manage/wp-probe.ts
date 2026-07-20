/**
 * Shared building blocks for the Manage console's secure in-pod probes. Every
 * panel gathers its data by running a `wp-cli`/shell batch inside the site's
 * running WordPress container (via execInWpPod) and parsing the result here —
 * the exact vetted pattern lib/health.ts and lib/plugins.ts already use. Pure and
 * cluster-free so the builders + parsers stay unit-testable.
 *
 * Shell-safety rule for the whole Manage layer: anything that reaches a command
 * line is either a compile-time constant or is validated against a strict
 * allow-list charset FIRST (see `safeWpArg`). The site's WordPress container is a
 * separate trust domain, so we never interpolate un-validated values, and every
 * probe reads with `--allow-root` (the official image runs wp-cli as root).
 */

/**
 * `--skip-plugins --skip-themes` keeps a broken plugin from fataling a read-only
 * probe: wp-cli still answers `core`/`option`/`db` queries even when a plugin
 * white-screens the normal bootstrap. Used by probes that don't need plugin code
 * loaded (versions, db, options). Probes that must see plugin state (plugin/theme
 * lists, WooCommerce) deliberately omit it.
 */
export const WP = "wp --allow-root";
export const WP_SAFE = "wp --allow-root --skip-plugins --skip-themes";

/** Strict wp-cli argument charset — slugs, versions, option keys. Refuses anything else. */
const SAFE_ARG_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Validate a value destined for a wp-cli argument. Mirrors wp-users/plugins:
 * refuse (throw) rather than quote, so a hostile value can never break out of the
 * script. Callers pass only slugs / option keys / versions through here.
 */
export function safeWpArg(value: string): string {
  if (!SAFE_ARG_RE.test(value)) {
    throw new Error(`refusing unsafe wp-cli argument: ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Wrap one shell probe so a single failure (DB briefly down, missing table,
 * plugin absent) yields an empty value instead of aborting the whole batch. The
 * pattern every KEY=VALUE line in lib/health.ts uses, factored out.
 */
export function kvLine(key: string, expr: string): string {
  return `echo "${key}=$(${expr} 2>/dev/null)"`;
}

/** Parse a batch of `KEY=VALUE` lines into a map (tolerant of extra/blank lines). */
export function parseKv(stdout: string): Map<string, string> {
  const kv = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    kv.set(line.slice(0, eq).trim(), line.slice(eq + 1));
  }
  return kv;
}

/** Non-negative integer from a probe value, or `null` when absent/unparseable. */
export function toInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  const t = value.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Float from a probe value (strips a trailing unit like `mb`), or `null`. */
export function toNum(value: string | undefined): number | null {
  if (value === undefined) return null;
  const t = value.trim().replace(/[a-z%]+$/i, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Trimmed string, or `null` when empty/absent. */
export function toStr(value: string | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

/**
 * Extract the first balanced JSON array or object from wp-cli output. wp-cli
 * sometimes prints a `Success:`/`Warning:` line alongside `--format=json`, so we
 * slice between the first `[`/`{` and its matching last bracket. Returns `null`
 * when there is no JSON (e.g. "Success: Translations are up to date.").
 */
export function sliceJson(stdout: string): string | null {
  const firstArr = stdout.indexOf("[");
  const firstObj = stdout.indexOf("{");
  const candidates = [firstArr, firstObj].filter((i) => i !== -1);
  if (candidates.length === 0) return null;
  const start = Math.min(...candidates);
  const open = stdout[start];
  const close = open === "[" ? "]" : "}";
  const end = stdout.lastIndexOf(close);
  if (end <= start) return null;
  return stdout.slice(start, end + 1);
}

/** Parse a wp-cli `--format=json` array; unparseable/empty output ⇒ `[]`. */
export function parseJsonArray<T = Record<string, unknown>>(stdout: string): T[] {
  const json = sliceJson(stdout);
  if (!json) return [];
  try {
    const rows = JSON.parse(json);
    return Array.isArray(rows) ? (rows as T[]) : [];
  } catch {
    return [];
  }
}

/** Parse a wp-cli `--format=json` object; unparseable/empty output ⇒ `null`. */
export function parseJsonObject<T = Record<string, unknown>>(stdout: string): T | null {
  const json = sliceJson(stdout);
  if (!json) return null;
  try {
    const obj = JSON.parse(json);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as T) : null;
  } catch {
    return null;
  }
}

/**
 * Parse `wp plugin list --status=active --field=name --format=json` into a set of
 * lowercased active plugin slugs. That command emits a SCALAR JSON array
 * (`["akismet", "woocommerce"]`), so each row is a bare string — reading it as an
 * object (`fieldStr(row,"name")`) yields nothing and silently blanks the set,
 * which then fails every plugin capability gate. We read the string directly and
 * also tolerate the object shape (`[{ name }]`) so a future wp-cli/format change
 * can't blind us. Empty / unparseable output ⇒ empty set.
 */
export function activePluginSlugs(stdout: string): Set<string> {
  const slugs = new Set<string>();
  for (const row of parseJsonArray<unknown>(stdout)) {
    const name =
      typeof row === "string"
        ? row
        : typeof (row as { name?: unknown })?.name === "string"
          ? (row as { name: string }).name
          : null;
    const slug = name?.trim().toLowerCase();
    if (slug) slugs.add(slug);
  }
  return slugs;
}

/** Read a scalar cell from a wp-cli field/option probe. */
export function fieldStr(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export function fieldNum(row: Record<string, unknown>, key: string): number | null {
  const v = row[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
