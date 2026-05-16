import type { GameEgg } from "@/lib/game-eggs";

const PELICAN_REPO = "pelican-eggs/eggs";
const PELICAN_TREE_API = `https://api.github.com/repos/${PELICAN_REPO}/git/trees`;
const PELICAN_RAW_BASE = `https://raw.githubusercontent.com/${PELICAN_REPO}`;
const CATALOG_CACHE_KEY = "catalog";
const CACHE_TTL_MS = 3_600_000;
const BRANCH_CANDIDATES = ["master", "main"] as const;
const GAME_EGG_PREFIX = "game_eggs/";

export interface PelicanEgg {
  meta?: { version: string; update_url?: string | null };
  exported_at?: string;
  name: string;
  author?: string;
  description?: string;
  /** PTDL_v1: single image string */
  docker_image?: string;
  /** PTDL_v2: map of human label → image (e.g. { "Java 21": "ghcr.io/..." }) */
  docker_images?: Record<string, string>;
  /** Files that should not be accessible to the user */
  file_denylist?: string[];
  startup?: string;
  config?: {
    stop?: string;
    /**
     * JSON-encoded string: '{"done": ")! For help, type "}'
     * Signals that the server finished starting when this appears in logs.
     */
    startup?: string | { done?: string };
    /**
     * JSON-encoded string describing config file patches.
     * Parser types: "properties" | "json" | "yaml"
     */
    files?: string | Record<string, unknown>;
    logs?: string | Record<string, unknown>;
  };
  /**
   * Platform feature flags.
   * Known values: "eula", "java_version", "pid_limit", "steam_disk_space"
   */
  features?: string[] | null;
  scripts?: {
    installation?: {
      script: string;
      container: string;
      entrypoint: string;
    };
  };
  variables?: Array<{
    name: string;
    description?: string;
    env_variable: string;
    default_value: string;
    user_viewable?: boolean;
    user_editable?: boolean;
    rules?: string;
    field_type?: "text" | "boolean" | "integer";
  }>;
}

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  dockerImage: string;
  /** Whether the egg exposes multiple runtime images (e.g. Java 17 vs 21) */
  hasMultipleImages: boolean;
  /** Known platform feature flags (e.g. "eula", "java_version", "pid_limit") */
  features: string[];
  author: string;
  path: string;
  categoryPath: string;
}

export interface CatalogCategory {
  name: string;
  path: string;
  eggs: Array<Pick<CatalogEntry, "id" | "name" | "description" | "dockerImage" | "hasMultipleImages" | "features" | "author" | "path">>;
}

interface GitTreeResponse {
  tree?: Array<{
    path: string;
    type?: string;
  }>;
}

const catalogCache = new Map<string, { data: CatalogEntry[]; fetchedAt: number }>();
const eggCache = new Map<string, { egg: GameEgg; pelican: PelicanEgg; fetchedAt: number }>();
let cachedBranch: string | null = null;

function githubHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    "User-Agent": "InfraWeaver-Console",
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `token ${token}`;
  return headers;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: githubHeaders(),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Pelican fetch failed (${response.status}) for ${url}`);
  }
  return (await response.json()) as T;
}

async function detectBranch(): Promise<string> {
  if (cachedBranch) return cachedBranch;

  for (const branch of BRANCH_CANDIDATES) {
    try {
      await fetchJson<GitTreeResponse>(`${PELICAN_TREE_API}/${branch}?recursive=1`);
      cachedBranch = branch;
      return branch;
    } catch {
      // try the next branch candidate
    }
  }

  throw new Error("Unable to resolve the Pelican eggs default branch");
}

function titleCase(value: string) {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeCatalogPath(path: string) {
  return path.startsWith(GAME_EGG_PREFIX) ? path.slice(GAME_EGG_PREFIX.length) : path;
}

function deriveCatalogId(path: string) {
  const normalized = normalizeCatalogPath(path).replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  const fileName = segments.pop() ?? "";
  if (/^egg(?:[-_].+)?\.json$/i.test(fileName)) {
    return segments.join("/") || fileName.replace(/\.json$/i, "");
  }
  return [...segments, fileName.replace(/\.json$/i, "")].filter(Boolean).join("/");
}

function deriveCategoryPath(path: string) {
  return normalizeCatalogPath(path).split("/").filter(Boolean)[0] ?? "misc";
}

function parsePortFromStartup(startup: string | undefined) {
  if (!startup) return null;
  const patterns = [
    /(?:^|\s)(?:--?port|port=)\s*=?\s*(\d{2,5})/i,
    /(?:^|\s)(?:-Port|-port)\s+(\d{2,5})/i,
    /:(\d{2,5})(?:\s|$)/,
  ];
  for (const pattern of patterns) {
    const match = startup.match(pattern);
    const port = Number.parseInt(match?.[1] ?? "", 10);
    if (Number.isFinite(port) && port > 0) return port;
  }
  return null;
}

function isValidCatalogEgg(pelican: PelicanEgg) {
  return typeof pelican.name === "string" && pelican.name.trim().length > 0;
}

function isCacheFresh(fetchedAt: number) {
  return Date.now() - fetchedAt < CACHE_TTL_MS;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function runWorker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()));
  return results;
}

function cacheEgg(path: string, pelican: PelicanEgg) {
  const id = deriveCatalogId(path);
  const egg = pelicanToGameEgg(pelican, id);
  eggCache.set(path, {
    egg,
    pelican,
    fetchedAt: Date.now(),
  });
  return egg;
}

async function fetchEggFile(path: string, branch: string) {
  const cached = eggCache.get(path);
  if (cached && isCacheFresh(cached.fetchedAt)) {
    return cached;
  }

  const pelican = await fetchJson<PelicanEgg>(`${PELICAN_RAW_BASE}/${branch}/${path}`);
  const egg = cacheEgg(path, pelican);
  const fresh = {
    egg,
    pelican,
    fetchedAt: Date.now(),
  };
  eggCache.set(path, fresh);
  return fresh;
}

async function getCatalogEntriesInternal() {
  const cached = catalogCache.get(CATALOG_CACHE_KEY);
  if (cached && isCacheFresh(cached.fetchedAt)) {
    return cached.data;
  }

  const branch = await detectBranch();
  const tree = await fetchJson<GitTreeResponse>(`${PELICAN_TREE_API}/${branch}?recursive=1`);
  const jsonPaths = (tree.tree ?? [])
    .filter((entry) => entry.type === "blob" && entry.path.endsWith(".json"))
    .map((entry) => entry.path);

  const entries = (await mapWithConcurrency(jsonPaths, 24, async (path) => {
    try {
      const { pelican, egg } = await fetchEggFile(path, branch);
      if (!isValidCatalogEgg(pelican)) return null;
      return {
        id: deriveCatalogId(path),
        name: pelican.name,
        description: pelican.description ?? "",
        dockerImage: egg.dockerImage,
        hasMultipleImages: Object.keys(pelican.docker_images ?? {}).length > 1,
        features: egg.features ?? [],
        author: pelican.author ?? "",
        path,
        categoryPath: deriveCategoryPath(path),
      } satisfies CatalogEntry;
    } catch {
      return null;
    }
  }))
    .filter((entry): entry is CatalogEntry => entry !== null)
    .sort((a, b) => a.categoryPath.localeCompare(b.categoryPath) || a.name.localeCompare(b.name));

  catalogCache.set(CATALOG_CACHE_KEY, {
    data: entries,
    fetchedAt: Date.now(),
  });

  return entries;
}

export function pelicanToGameEgg(pelican: PelicanEgg, id: string): GameEgg {
  // PTDL_v2 uses docker_images (map); PTDL_v1 uses docker_image (string).
  // Build a normalised map so we always have both dockerImage and dockerImages.
  const rawImages = pelican.docker_images ?? {};
  const hasManyImages = Object.keys(rawImages).length > 0;
  const dockerImages: Record<string, string> = hasManyImages
    ? rawImages
    : pelican.docker_image
    ? { [pelican.docker_image]: pelican.docker_image }
    : {};
  const dockerImage =
    Object.values(dockerImages)[0] ?? pelican.docker_image ?? "ubuntu:22.04";

  const portVar = pelican.variables?.find((variable) =>
    variable.env_variable.toUpperCase().includes("PORT") || variable.name.toLowerCase().includes("port")
  );
  const gamePort = Number.parseInt(portVar?.default_value ?? "", 10) || parsePortFromStartup(pelican.startup) || 25565;
  const protocol = /valheim|terraria|cs.*go|ark|rust|factorio|quake/i.test(`${pelican.name} ${id}`) ? "UDP" : "TCP";

  // Parse `config.startup` — it can be a JSON-encoded string or an object
  let startupReadySignal: string | undefined;
  const rawStartup = pelican.config?.startup;
  if (rawStartup) {
    if (typeof rawStartup === "string") {
      try {
        const parsed = JSON.parse(rawStartup) as { done?: string };
        startupReadySignal = parsed.done ?? undefined;
      } catch {
        // not JSON-encoded — use as-is if it's a plain string signal
      }
    } else if (typeof rawStartup === "object" && rawStartup.done) {
      startupReadySignal = rawStartup.done;
    }
  }

  const features = (pelican.features ?? []).filter((f): f is string => typeof f === "string" && f.length > 0);

  return {
    id,
    name: pelican.name,
    description: pelican.description ?? "",
    dockerImage,
    dockerImages: Object.keys(dockerImages).length > 1 ? dockerImages : undefined,
    startupCommand: pelican.startup ?? "",
    stopCommand: pelican.config?.stop ?? "^C",
    startupReadySignal: startupReadySignal || undefined,
    gamePort,
    mountPath: "/home/container",
    protocol,
    ports: [{ name: "game", port: gamePort, protocol }],
    environment: (pelican.variables ?? []).map((variable) => ({
      name: variable.env_variable,
      description: variable.name + (variable.description ? `: ${variable.description}` : ""),
      defaultValue: variable.default_value,
      required: variable.rules?.includes("required") ?? false,
      fieldType: variable.field_type ?? "text",
      userViewable: variable.user_viewable,
      userEditable: variable.user_editable,
      rules: variable.rules,
    })),
    quickCommands: [],
    defaultMemory: "2Gi",
    defaultCpu: "1",
    defaultStorage: "10Gi",
    features: features.length > 0 ? features : undefined,
    fileDenylist: pelican.file_denylist?.length ? pelican.file_denylist : undefined,
    author: pelican.author || undefined,
    exportedAt: pelican.exported_at || undefined,
    installScript: pelican.scripts?.installation
      ? {
          script: pelican.scripts.installation.script,
          container: pelican.scripts.installation.container,
          entrypoint: pelican.scripts.installation.entrypoint,
        }
      : undefined,
  };
}

export async function getPelicanCatalog() {
  const entries = await getCatalogEntriesInternal();
  const categoriesMap = new Map<string, CatalogCategory>();

  for (const entry of entries) {
    const existing = categoriesMap.get(entry.categoryPath);
    const eggSummary = {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      dockerImage: entry.dockerImage,
      hasMultipleImages: entry.hasMultipleImages,
      features: entry.features,
      author: entry.author,
      path: entry.path,
    };

    if (existing) {
      existing.eggs.push(eggSummary);
      continue;
    }

    categoriesMap.set(entry.categoryPath, {
      name: titleCase(entry.categoryPath),
      path: entry.categoryPath,
      eggs: [eggSummary],
    });
  }

  const categories = [...categoriesMap.values()]
    .map((category) => ({
      ...category,
      eggs: [...category.eggs].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    categories,
    total: entries.length,
  };
}

export async function getPelicanCatalogEntry(identifier: string) {
  const entries = await getCatalogEntriesInternal();
  const normalizedIdentifier = identifier.replace(/^\/+/, "");
  return entries.find((entry) =>
    entry.id === normalizedIdentifier ||
    entry.path === normalizedIdentifier ||
    normalizeCatalogPath(entry.path) === normalizedIdentifier
  ) ?? null;
}

export async function getPelicanGameEgg(identifier: string) {
  const branch = await detectBranch();
  const entry = await getPelicanCatalogEntry(identifier);
  if (!entry) {
    throw new Error(`Pelican egg not found: ${identifier}`);
  }

  const cached = eggCache.get(entry.path);
  const fresh = cached && isCacheFresh(cached.fetchedAt) ? cached : await fetchEggFile(entry.path, branch);

  return {
    egg: fresh.egg,
    pelican: fresh.pelican,
    entry,
  };
}
