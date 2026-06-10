// ─────────────────────────────────────────────────────────────────────────────
// platform-config-server.ts — SERVER-ONLY resolver for the git-backed platform
// identity. Imports node-only git-provider, so it must never be imported from a
// client component. The sync constants/helpers/schema live in ./platform-config
// (client-safe); this module adds level-1 (git) resolution on top.
// ─────────────────────────────────────────────────────────────────────────────
import { getGitAccessToken, gitReadFile } from "@/lib/git-provider";
import {
  PlatformIdentitySchema,
  envAndDefaultIdentity,
  overlayIdentity,
  type PlatformIdentityInput,
  type ResolvedPlatformIdentity,
} from "@/lib/platform-config";

const IDENTITY_TTL_MS = 30_000;
let _identityCache: { value: ResolvedPlatformIdentity; at: number } | null = null;
let _inflight: Promise<ResolvedPlatformIdentity> | null = null;

// Committed infra config follows the fork model: values may be un-substituted
// `${PLACEHOLDER}` tokens (filled at deploy by generate-from-env.sh). Strip any
// such value so a template checkout falls back to env/defaults instead of
// feeding a literal "${BASE_DOMAIN}" into the app.
const PLACEHOLDER_RE = /\$\{[^}]+\}/;

function stripPlaceholders(value: unknown): unknown {
  if (typeof value === "string") return PLACEHOLDER_RE.test(value) ? undefined : value;
  if (Array.isArray(value)) {
    return value.filter((v) => !(typeof v === "string" && PLACEHOLDER_RE.test(v)));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = stripPlaceholders(v);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }
  return value;
}

async function loadGitIdentity(): Promise<PlatformIdentityInput | null> {
  try {
    if (!getGitAccessToken().trim()) return null;
    const file = await gitReadFile("platform.yaml", IDENTITY_TTL_MS / 1000);
    if (!file) return null;
    const yaml = await import("js-yaml");
    const parsed = yaml.load(file.content) as { identity?: unknown } | null;
    if (!parsed || typeof parsed !== "object" || parsed.identity == null) return null;
    const result = PlatformIdentitySchema.safeParse(stripPlaceholders(parsed.identity));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the platform identity git → env → default, cached for IDENTITY_TTL_MS.
 * Never throws — degrades to env/defaults on any failure.
 */
export async function getPlatformIdentity(): Promise<ResolvedPlatformIdentity> {
  const now = Date.now();
  if (_identityCache && now - _identityCache.at < IDENTITY_TTL_MS) return _identityCache.value;
  if (_inflight) return _inflight;

  _inflight = (async () => {
    const base = envAndDefaultIdentity();
    const git = await loadGitIdentity();
    const value = git ? overlayIdentity(base, git) : base;
    _identityCache = { value, at: Date.now() };
    return value;
  })().finally(() => {
    _inflight = null;
  });

  return _inflight;
}

/** Test/runtime hook to force a reload on next read. */
export function invalidatePlatformIdentity(): void {
  _identityCache = null;
}
