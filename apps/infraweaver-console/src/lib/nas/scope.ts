/**
 * NAS RBAC scopes.
 *
 * Why this exists
 * ---------------
 * Storage access used to live in its own universe: a `NAS_FOLDER_ACL_JSON` env
 * var matching raw Authentik group names. That made folder access unassignable
 * from the console (an env change means a redeploy), invisible to the RBAC
 * visualizer, and exempt from the audit log, expiry, Deny effects and the
 * privilege ceiling that govern every other resource.
 *
 * This module maps a NAS location onto the same Azure-style scope hierarchy the
 * rest of InfraWeaver already uses (`/wordpress/sites/<site>`,
 * `/game-hub/servers/<server>`):
 *
 *   /nas                                  all storage
 *   /nas/<provider>                       one appliance
 *   /nas/<provider>/<share>               one share
 *   /nas/<provider>/<share>/<subfolder>   one folder, at any depth
 *
 * Everything else then comes for free from `@/lib/rbac`: a grant on a share
 * inherits to every folder beneath it (`scopeCovers`), a grant on `/` (platform
 * owner) covers all storage, and `scopeCovers` is boundary-aware on "/" so a
 * grant on `/nas/truenas/media` never leaks into `/nas/truenas/media-archive`.
 *
 * Case
 * ----
 * Scopes are lowercased. Two independent reasons, both binding:
 *   1. The RBAC scope grammar enforced by the assignments API is
 *      `/^\/(|[a-z0-9/_-]+)$/` — an uppercase scope is simply not grantable.
 *   2. SMB/CIFS shares and folders are case-insensitive, so `Media` and `media`
 *      are the same folder and must not resolve to two different scopes (which
 *      would let a caller sidestep a grant by changing the case of a path).
 */
import type { ScopePath } from "@/lib/rbac";

/** Root of the storage subtree. A grant here covers every provider. */
export const NAS_SCOPE_ROOT = "/nas";

/**
 * The characters a scope segment may contain, after lowercasing. Deliberately
 * narrower than what a NAS accepts in a folder name: a segment that cannot be
 * expressed here cannot be granted, so we refuse to mint a scope for it rather
 * than silently emit one the assignments API would reject (or, worse, one that
 * changes meaning — e.g. a segment containing "/" would forge a scope level).
 */
const SEGMENT_RE = /^[a-z0-9_-]+$/;

export class NasScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NasScopeError";
  }
}

/** Lowercases and validates one path segment. */
function segment(value: string, kind: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "." || normalized === "..") {
    throw new NasScopeError(`${kind} '${value}' is a relative path segment`);
  }
  if (!SEGMENT_RE.test(normalized)) {
    throw new NasScopeError(`${kind} '${value}' is not addressable as an RBAC scope (allowed: a-z 0-9 _ -)`);
  }
  return normalized;
}

/** `/nas/<provider>` — a grant here covers every share on the appliance. */
export function nasProviderScope(provider: string): ScopePath {
  return `${NAS_SCOPE_ROOT}/${segment(provider, "provider")}`;
}

/** `/nas/<provider>/<share>` — a grant here covers every folder in the share. */
export function nasShareScope(provider: string, share: string): ScopePath {
  return `${nasProviderScope(provider)}/${segment(share, "share")}`;
}

/**
 * `/nas/<provider>/<share>/<subfolder>` for an arbitrarily deep subfolder.
 * An empty (or "/") subfolder yields the share scope itself.
 *
 * Throws on traversal (`..`) instead of normalizing it away: a caller that
 * reaches here with `movies/../../etc` has a bug or is probing, and quietly
 * resolving it to a *higher* scope than requested is how a check gets bypassed.
 */
export function nasFolderScope(provider: string, share: string, subfolder = ""): ScopePath {
  const base = nasShareScope(provider, share);
  const relative = subfolder.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!relative) return base;
  const segments = relative.split("/").filter(Boolean).map((part) => segment(part, "subfolder segment"));
  return `${base}/${segments.join("/")}`;
}

/**
 * The scope a folder is AUTHORIZED at: `nasFolderScope` when every segment is
 * addressable, otherwise the deepest addressable ancestor.
 *
 * Why this is not a security hole
 * ------------------------------
 * Real media libraries are full of names this scope grammar cannot express —
 * `Season.01`, `Movie.2024`, `The Wire`. Evaluating those strictly would deny a
 * Contributor on `media` access to `media/Season.01`, even though a grant on a
 * share ALREADY covers everything beneath it. Falling back to the deepest
 * addressable ancestor restores exactly that inheritance and nothing more: the
 * caller is checked against an ancestor of the folder they asked for, so they
 * can never gain access the ancestor did not already confer.
 *
 * Granting still uses the strict {@link nasFolderScope}: you may not create a
 * grant *on* an unaddressable folder (there is no name for it), only inherit one.
 *
 * Throws only when the provider or share themselves are unaddressable, which
 * would leave no scope to fall back to.
 */
export function nasAuthorizationScope(provider: string, share: string, subfolder = ""): ScopePath {
  const base = nasShareScope(provider, share);
  const relative = subfolder.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!relative) return base;

  const addressable: string[] = [];
  for (const part of relative.split("/").filter(Boolean)) {
    const normalized = part.trim().toLowerCase();
    // Stop at the first segment that cannot be a scope segment. Everything below
    // it inherits from here. `..` never gets this far (normalizeSubfolder rejects
    // it at the API boundary) but stopping on it is the safe direction anyway.
    if (!SEGMENT_RE.test(normalized) || normalized === "." || normalized === "..") break;
    addressable.push(normalized);
  }
  return addressable.length > 0 ? `${base}/${addressable.join("/")}` : base;
}

export interface ParsedNasScope {
  provider: string;
  share: string;
  /** Share-relative, "" for the share itself. Never leading/trailing "/". */
  subfolder: string;
}

/**
 * Inverse of {@link nasFolderScope}. Returns null for anything that is not a
 * share-or-deeper storage scope — including `/nas` and `/nas/<provider>`, which
 * are grantable but do not identify a folder.
 */
export function parseNasScope(scope: string): ParsedNasScope | null {
  const segments = scope.split("/").filter(Boolean);
  if (segments[0] !== "nas") return null;
  if (segments.length < 3) return null;
  return {
    provider: segments[1],
    share: segments[2],
    subfolder: segments.slice(3).join("/"),
  };
}

/** True when `scope` is inside the storage subtree (including `/nas` itself). */
export function isNasScope(scope: string): boolean {
  const segments = scope.split("/").filter(Boolean);
  return segments[0] === "nas";
}

/**
 * A human label for a storage scope, for audit lines and the access UI.
 * `/nas/truenas/media/movies` -> `truenas / media / movies`.
 */
export function describeNasScope(scope: string): string {
  const parsed = parseNasScope(scope);
  if (!parsed) return scope;
  return [parsed.provider, parsed.share, parsed.subfolder].filter(Boolean).join(" / ");
}
