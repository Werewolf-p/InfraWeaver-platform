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

interface ManifestData {
  byId: Map<string, ManifestEntry>;
  latest: { release: string; snapshot: string };
  releaseIds: string[];
}

let manifestCache: { fetchedAt: number; data: ManifestData } | null = null;
const requiredJavaCache = new Map<string, number | null>();

async function loadManifest(): Promise<ManifestData> {
  if (manifestCache && Date.now() - manifestCache.fetchedAt < CACHE_TTL_MS) {
    return manifestCache.data;
  }
  const res = await fetch(MANIFEST_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Mojang manifest fetch failed: ${res.status}`);
  const data = (await res.json()) as { versions: ManifestEntry[]; latest?: { release?: string; snapshot?: string } };
  const byId = new Map(data.versions.map((v) => [v.id, v]));
  const releaseIds = data.versions.filter((v) => v.type === "release").map((v) => v.id);
  const parsed: ManifestData = {
    byId,
    latest: { release: data.latest?.release ?? releaseIds[0] ?? "", snapshot: data.latest?.snapshot ?? "" },
    releaseIds,
  };
  manifestCache = { fetchedAt: Date.now(), data: parsed };
  return parsed;
}

/** The list of Minecraft *release* version ids, newest first. */
export async function listMinecraftReleaseVersions(): Promise<{ versions: string[]; latestRelease: string }> {
  try {
    const { releaseIds, latest } = await loadManifest();
    return { versions: releaseIds, latestRelease: latest.release };
  } catch {
    return { versions: [], latestRelease: "" };
  }
}

/** Values that mean "resolve to the newest build" — mapped to the manifest's latest release/snapshot. */
const DYNAMIC_TO_LATEST = new Map([["latest", "release"], ["recommended", "release"], ["snapshot", "snapshot"]]);

/**
 * The minimum Java major version required to run a given Minecraft version.
 * Dynamic values ("latest"/"recommended"/"snapshot") resolve to the manifest's
 * newest build so we can still constrain the runtime image. Returns null only
 * when the version is empty, unknown, or the lookup fails.
 */
export async function requiredJavaForMinecraftVersion(version: string): Promise<number | null> {
  const v = version.trim().toLowerCase();
  if (v === "") return null;
  if (requiredJavaCache.has(v)) return requiredJavaCache.get(v) ?? null;

  try {
    const manifest = await loadManifest();
    // Resolve "latest"/"snapshot"/"recommended" to a concrete manifest id.
    const dynamicKind = DYNAMIC_TO_LATEST.get(v);
    const concreteId = dynamicKind ? (dynamicKind === "snapshot" ? manifest.latest.snapshot : manifest.latest.release) : version.trim();
    const entry = manifest.byId.get(concreteId);
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
