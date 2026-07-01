// Minecraft version <-> Java compatibility, sourced from the official Mojang
// version manifest (each version JSON carries javaVersion.majorVersion). Used to
// stop users pairing a Java runtime image that is too old for a given Minecraft
// version — both as a backend guard and to drive the create wizard's UI.
import { javaMajorFromImage } from "@/addons/gamehub/lib/game-eggs";

const MANIFEST_URL = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h — Mojang versions are immutable once published

interface ManifestEntry {
  id: string;
  type: string;
  url: string;
}

let manifestCache: { fetchedAt: number; byId: Map<string, ManifestEntry> } | null = null;
const requiredJavaCache = new Map<string, number | null>();

async function loadManifest(): Promise<Map<string, ManifestEntry>> {
  if (manifestCache && Date.now() - manifestCache.fetchedAt < CACHE_TTL_MS) {
    return manifestCache.byId;
  }
  const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Mojang manifest fetch failed: ${res.status}`);
  const data = (await res.json()) as { versions: ManifestEntry[] };
  const byId = new Map(data.versions.map((v) => [v.id, v]));
  manifestCache = { fetchedAt: Date.now(), byId };
  return byId;
}

/** Values that mean "let the installer resolve it" — no fixed version to validate. */
const DYNAMIC_VERSIONS = new Set(["", "latest", "snapshot", "recommended"]);

/**
 * The minimum Java major version required to run a given Minecraft version.
 * Returns null when the version is dynamic ("latest"), unknown, or the lookup
 * fails — callers treat null as "no constraint" and fall back to the
 * installer-side cap.
 */
export async function requiredJavaForMinecraftVersion(version: string): Promise<number | null> {
  const v = version.trim().toLowerCase();
  if (DYNAMIC_VERSIONS.has(v)) return null;
  if (requiredJavaCache.has(v)) return requiredJavaCache.get(v) ?? null;

  try {
    const byId = await loadManifest();
    const entry = byId.get(version.trim());
    if (!entry) {
      requiredJavaCache.set(v, null);
      return null;
    }
    const res = await fetch(entry.url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const detail = (await res.json()) as { javaVersion?: { majorVersion?: number } };
    const major = detail.javaVersion?.majorVersion ?? null;
    requiredJavaCache.set(v, major);
    return major;
  } catch {
    return null;
  }
}

export interface JavaCompatResult {
  compatible: boolean;
  /** Java major the image provides, or null if the image is not a Java runtime. */
  imageJava: number | null;
  /** Java major the version needs, or null if unconstrained/unknown. */
  requiredJava: number | null;
  reason?: string;
}

/**
 * Check whether a runtime image can run a Minecraft version. Non-Java images and
 * dynamic/unknown versions are treated as compatible (no basis to reject).
 */
export async function checkJavaCompatibility(image: string, version: string): Promise<JavaCompatResult> {
  const imageJava = javaMajorFromImage(image);
  const requiredJava = await requiredJavaForMinecraftVersion(version);
  if (imageJava === null || requiredJava === null) {
    return { compatible: true, imageJava, requiredJava };
  }
  const compatible = imageJava >= requiredJava;
  return {
    compatible,
    imageJava,
    requiredJava,
    reason: compatible
      ? undefined
      : `Minecraft ${version.trim()} requires Java ${requiredJava} or newer, but the selected image provides Java ${imageJava}.`,
  };
}

/** Env keys different Minecraft eggs use to hold the game version. */
export const MINECRAFT_VERSION_ENV_KEYS = ["MINECRAFT_VERSION", "MC_VERSION", "VANILLA_VERSION"] as const;

/** Extract the Minecraft version from an egg's env, if present. */
export function minecraftVersionFromEnv(env: Record<string, string> | undefined): string | null {
  if (!env) return null;
  for (const key of MINECRAFT_VERSION_ENV_KEYS) {
    if (env[key] != null && env[key] !== "") return env[key];
  }
  return null;
}
