import "server-only";

/**
 * Catalog key-coverage collector — SERVER ONLY.
 *
 * Mirrors `scripts/seed-catalog-secrets.sh`: reads the enabled catalog apps from
 * `platform.yaml`, each app's `secrets:` section from
 * `kubernetes/catalog/<app>/catalog.yaml`, the seeded keys from OpenBao, and the
 * keys ExternalSecrets reference — then diffs them so fresh-install seed gaps
 * (declared-but-unseeded) and dangling references (referenced-but-undeclared)
 * are visible BEFORE they wedge a deploy.
 */

import { gitReadFile } from "@/lib/git-provider";
import { readKv } from "@/lib/openbao/kv";
import { diffCatalogCoverage, type CatalogCoverage, type EsLifecycle } from "@/lib/secrets/lifecycle-types";

// Guard the app segment before it becomes a git path (no `../`, no mount hop).
const SAFE_APP_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/i;
const PLATFORM_YAML_TTL_SECONDS = 30;

interface CatalogSecretsSection {
  path?: string;
  keys?: Record<string, { type?: string; value?: string }>;
}

/** Read `catalog.enabled` from platform.yaml. Returns [] on any failure. */
async function readEnabledApps(): Promise<string[]> {
  try {
    const file = await gitReadFile("platform.yaml", PLATFORM_YAML_TTL_SECONDS);
    if (!file) return [];
    const yaml = await import("js-yaml");
    const parsed = yaml.load(file.content) as { catalog?: { enabled?: unknown } } | null;
    const enabled = parsed?.catalog?.enabled;
    if (!Array.isArray(enabled)) return [];
    return enabled.filter((app): app is string => typeof app === "string" && SAFE_APP_NAME.test(app));
  } catch {
    return [];
  }
}

/** Read a single app's `secrets:` section from its catalog.yaml. null when absent. */
export async function readCatalogSecrets(app: string): Promise<CatalogSecretsSection | null> {
  if (!SAFE_APP_NAME.test(app)) return null;
  try {
    const file = await gitReadFile(`kubernetes/catalog/${app}/catalog.yaml`);
    if (!file) return null;
    const yaml = await import("js-yaml");
    const parsed = yaml.load(file.content) as { secrets?: CatalogSecretsSection } | null;
    const secrets = parsed?.secrets;
    if (!secrets || typeof secrets !== "object" || !secrets.path) return null;
    return secrets;
  } catch {
    return null;
  }
}

/** Map ES-referenced keys → { path → Set<property> } for the referenced column. */
function referencedByPath(externalSecrets: EsLifecycle[]): Map<string, Set<string>> {
  const byPath = new Map<string, Set<string>>();
  for (const es of externalSecrets) {
    for (const ref of es.referencedKeys) {
      if (ref.property === null) continue; // whole-path extract has no specific key
      const set = byPath.get(ref.path) ?? new Set<string>();
      set.add(ref.property);
      byPath.set(ref.path, set);
    }
  }
  return byPath;
}

/**
 * Build the per-app coverage matrix. `externalSecrets` supplies the referenced
 * column; pass `[]` when ES data is unavailable (referenced stays empty).
 */
export async function collectCatalogCoverage(externalSecrets: EsLifecycle[]): Promise<CatalogCoverage[]> {
  const enabledApps = await readEnabledApps();
  if (enabledApps.length === 0) return [];

  const refByPath = referencedByPath(externalSecrets);
  const coverage: CatalogCoverage[] = [];

  for (const app of enabledApps) {
    const secrets = await readCatalogSecrets(app);
    if (!secrets || !secrets.path) continue; // app declares no secrets — nothing to cover

    const path = secrets.path;
    const declaredKeys = Object.keys(secrets.keys ?? {}).sort();

    let seededKeys: string[] = [];
    try {
      const data = await readKv(path);
      seededKeys = data && typeof data === "object" ? Object.keys(data as Record<string, unknown>).sort() : [];
    } catch {
      seededKeys = [];
    }

    const referencedKeys = Array.from(refByPath.get(path) ?? []).sort();
    const { missingKeys, undeclaredReferencedKeys } = diffCatalogCoverage(declaredKeys, seededKeys, referencedKeys);

    coverage.push({ app, path, declaredKeys, seededKeys, referencedKeys, missingKeys, undeclaredReferencedKeys });
  }

  return coverage;
}
