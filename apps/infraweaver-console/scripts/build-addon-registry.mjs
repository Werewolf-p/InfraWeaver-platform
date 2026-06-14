#!/usr/bin/env node
// build-addon-registry.mjs
// Scans addons folder for addon.manifest.ts files and emits src/generated/addon-registry.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const consoleRoot = path.resolve(__dirname, "..");
const addonsRoot = path.join(consoleRoot, "src/addons");
const outputPath = path.join(consoleRoot, "src/generated/addon-registry.ts");

// ── helpers ───────────────────────────────────────────────────────────────────

/** Extract a string field from an object literal source text. */
function extractString(src, key) {
  const m = new RegExp(`\\b${key}\\s*:\\s*["']([^"']+)["']`).exec(src);
  return m ? m[1] : undefined;
}

/** Extract a boolean field. */
function extractBool(src, key) {
  const m = new RegExp(`\\b${key}\\s*:\\s*(true|false)`).exec(src);
  if (!m) return undefined;
  return m[1] === "true";
}

/**
 * Extract an array of objects from a field. Only handles the simple pattern:
 *   field: [ { ... }, { ... } ]
 * Returns raw string contents between [ ... ] for the field.
 */
function extractArrayOf(src, key) {
  const start = src.indexOf(`${key}: [`);
  if (start === -1) return [];
  let i = src.indexOf("[", start);
  let depth = 0;
  let end = i;
  while (end < src.length) {
    if (src[end] === "[") depth++;
    else if (src[end] === "]") { depth--; if (depth === 0) break; }
    end++;
  }
  const block = src.slice(i + 1, end);
  // split on }, { boundaries
  const items = [];
  const objPattern = /\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
  let match;
  while ((match = objPattern.exec(block)) !== null) {
    items.push(match[0]);
  }
  return items;
}

function parseNavItems(src) {
  const block = extractArrayOf(src, "navItems");
  return block.map(item => ({
    href: extractString(item, "href") ?? "",
    label: extractString(item, "label") ?? "",
    icon: extractString(item, "icon") ?? "",
    group: extractString(item, "group") ?? "",
  })).filter(n => n.href);
}

function parsePages(src) {
  const block = extractArrayOf(src, "pages");
  return block.map(item => ({
    path: extractString(item, "path") ?? "",
    component: extractString(item, "component") ?? "",
    title: extractString(item, "title") ?? "",
    group: extractString(item, "group") ?? "",
  })).filter(p => p.path);
}

function parseK8s(src) {
  const nsMatch = /namespace\s*:\s*["']([^"']+)["']/.exec(src);
  return nsMatch ? { namespace: nsMatch[1] } : undefined;
}

/** Read and parse one addon folder. Returns null if invalid. */
function parseAddonFolder(addonDir) {
  const manifestPath = path.join(addonDir, "addon.manifest.ts");
  if (!fs.existsSync(manifestPath)) return null;

  const src = fs.readFileSync(manifestPath, "utf8");
  const id = extractString(src, "id");
  if (!id) { console.warn(`[addon-registry] No id found in ${manifestPath}`); return null; }

  return {
    id,
    name: extractString(src, "name") ?? id,
    version: extractString(src, "version"),
    description: extractString(src, "description") ?? "",
    icon: extractString(src, "icon") ?? "Puzzle",
    category: extractString(src, "category") ?? "infrastructure",
    author: extractString(src, "author"),
    defaultEnabled: extractBool(src, "defaultEnabled"),
    requiresSetup: extractBool(src, "requiresSetup"),
    setupPath: extractString(src, "setupPath"),
    scopePrefix: extractString(src, "scopePrefix"),
    navItems: parseNavItems(src),
    pages: parsePages(src),
    k8s: parseK8s(src),
    // addonKey = folder name, used to build import paths
    _folderName: path.basename(addonDir),
    _manifestRelPath: path.relative(consoleRoot, manifestPath).replace(/\\/g, "/"),
  };
}

// ── scan ──────────────────────────────────────────────────────────────────────

if (!fs.existsSync(addonsRoot)) {
  console.log("[addon-registry] No addons/ directory found — writing empty registry.");
}

const addonEntries = fs.existsSync(addonsRoot)
  ? fs.readdirSync(addonsRoot, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => parseAddonFolder(path.join(addonsRoot, d.name)))
      .filter(Boolean)
  : [];

console.log(`[addon-registry] Found ${addonEntries.length} addon(s): ${addonEntries.map(a => a.id).join(", ")}`);

// ── emit ──────────────────────────────────────────────────────────────────────

const manifestsJson = JSON.stringify(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  addonEntries.map(({ _folderName, _manifestRelPath, ...rest }) => rest),
  null,
  2,
);

// Build literal import() lines — bundler requires literal string specifiers
const pageLoaderLines = addonEntries.flatMap(addon =>
  (addon.pages ?? []).map(page => {
    const importPath = `@/addons/${addon._folderName}/${page.component}`;
    const key = `${addon.id}::${page.path}`;
    return `  "${key}": () => import("${importPath}"),`;
  })
);

const manifestLines = addonEntries.map(addon => {
  const importPath = `@/addons/${addon._folderName}/addon.manifest`;
  return `  "${addon.id}": () => import("${importPath}"),`;
});

const output = `// AUTO-GENERATED by scripts/build-addon-registry.mjs — do not edit by hand.
// Re-run via: npm run prebuild  (or npm run build)
// Committed to repo so a clean checkout builds without running the script.
import type { AddonManifest } from "@/lib/addon-sdk/types";

// ── Static manifest data (extracted at build time) ────────────────────────────

export const ADDON_MANIFESTS: AddonManifest[] = ${manifestsJson} as AddonManifest[];

// ── Lazy manifest loaders (literal specifiers for bundler) ───────────────────

export const ADDON_MANIFEST_LOADERS: Record<string, () => Promise<{ default: AddonManifest }>> = {
${manifestLines.join("\n")}
};

// ── Lazy page loaders keyed by "<addonId>::<path>" ──────────────────────────

export const ADDON_PAGE_LOADERS: Record<string, () => Promise<unknown>> = {
${pageLoaderLines.join("\n")}
};

// ── API handler loaders (P2 — populated when addon api[] is non-empty) ───────

export const ADDON_API_HANDLERS: Record<string, () => Promise<unknown>> = {};
`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, output, "utf8");
console.log(`[addon-registry] Wrote ${outputPath}`);
