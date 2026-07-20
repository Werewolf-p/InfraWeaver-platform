/**
 * Paid-feature entitlements — the console-side data model + normalization.
 *
 * Designed as a GENERAL boolean flag map so future paid features slot in with no
 * schema change: `plus` is the first flag. The console is authoritative — it
 * persists the intended set per site (registry) AND pushes it to the plugin over
 * the signed command channel (`entitlements.set`). The plugin trusts the map only
 * because it arrived dual-signed; the site can never self-grant a flag.
 *
 * Pure module (no server deps) so it is importable from the isomorphic RPC
 * registry, the server-only managed-ops mutator, and unit tests alike.
 */

/**
 * Known grantable feature flags. The plugin accepts ANY `[a-z0-9_]` flag
 * (bounded), so this list is the console's own UI/validation surface — add a flag
 * here to make it grantable from the console, then reference it from a tier in
 * `tiers.ts`; no other change required. `plus` stays first because the plugin's
 * local feature gate (`IWSL_Entitlements::evaluate`) defaults to it, so every paid
 * tier must grant `plus` to unlock the plugin-side Plus view.
 */
export const ENTITLEMENT_FLAGS = [
  "plus",
  "priority_support",
  "advanced_analytics",
  "white_label",
  "image_optimization",
  "db_optimization",
  "email_delivery",
  "redirect_manager",
] as const;
export type EntitlementFlag = (typeof ENTITLEMENT_FLAGS)[number];

/** Operator-facing metadata for a single entitlement flag (drives the UI). */
export interface EntitlementFlagMeta {
  readonly flag: EntitlementFlag;
  readonly label: string;
  readonly description: string;
}

/**
 * Display metadata for each known flag. Kept next to `ENTITLEMENT_FLAGS` so a new
 * flag is defined and described in one place. UI-only — never sent over the wire.
 */
export const ENTITLEMENT_FLAG_META: Readonly<Record<EntitlementFlag, EntitlementFlagMeta>> = {
  plus: {
    flag: "plus",
    label: "Plus features",
    description: "Unlocks the plugin-side Plus feature set on the linked site.",
  },
  priority_support: {
    flag: "priority_support",
    label: "Priority support",
    description: "Fast-lane support queue for this site.",
  },
  advanced_analytics: {
    flag: "advanced_analytics",
    label: "Advanced analytics",
    description: "Deeper traffic and performance reporting.",
  },
  white_label: {
    flag: "white_label",
    label: "White-label branding",
    description: "Removes InfraWeaver branding from client-facing surfaces.",
  },
  image_optimization: {
    flag: "image_optimization",
    label: "Lossless image optimization",
    description:
      "Unlocks on-site, pixel-preserving image conversion (JPEG/PNG → lossless WebP) run locally on the linked WordPress. Gated strictly — lower tiers cannot invoke it.",
  },
  db_optimization: {
    flag: "db_optimization",
    label: "Database cleanup & optimization",
    description:
      "Safe, bounded local database housekeeping — expired transients, excess revisions, trashed/spam content, orphaned metadata, and table optimization, with a dry-run preview.",
  },
  email_delivery: {
    flag: "email_delivery",
    label: "SMTP delivery & email log",
    description:
      "Routes outgoing WordPress mail through a configured SMTP relay and keeps a capped, redacted send log so deliverability problems are visible on the site.",
  },
  redirect_manager: {
    flag: "redirect_manager",
    label: "301 redirect manager",
    description:
      "Manage 301/302 redirects and monitor 404s locally — open-redirect-safe, capped, and applied early on the linked site.",
  },
};

/** Boolean flag map — the exact shape sent to the plugin over the signed channel. */
export type EntitlementMap = Partial<Record<EntitlementFlag, boolean>>;

/** Persisted per-site entitlement state: the flags plus an audit trail. */
export interface SiteEntitlements {
  /** The console-authoritative flag map mirrored from the last signed push. */
  flags: EntitlementMap;
  /** ISO8601 of the last change. */
  updatedAt?: string;
  /** Operator who made the last change (audit). */
  updatedBy?: string;
}

/** Wire/payload bound: mirrors the plugin's `IWSL_Entitlements::MAX_FLAGS`. */
export const MAX_ENTITLEMENT_FLAGS = 32;
/** Flag-name shape — mirrors the plugin's `FLAG_RE`. */
export const ENTITLEMENT_FLAG_RE = /^[a-z0-9_]{1,64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize arbitrary input into a bounded boolean flag map that only carries
 * KNOWN flags with boolean values. This is what gets both persisted and pushed,
 * so an out-of-model or malformed key from any caller can never reach the wire.
 */
export function normalizeEntitlements(input: unknown): EntitlementMap {
  if (!isPlainObject(input)) return {};
  const out: EntitlementMap = {};
  for (const flag of ENTITLEMENT_FLAGS) {
    if (typeof input[flag] === "boolean") out[flag] = input[flag] as boolean;
  }
  return out;
}

/** Whether a site holds a given entitlement flag. */
export function isEntitled(entitlements: SiteEntitlements | undefined, flag: EntitlementFlag): boolean {
  return entitlements?.flags?.[flag] === true;
}

/**
 * Client-side sanity check for the `entitlements.set` params, in parity with the
 * plugin's `IWSL_Entitlements::validate_params`: exactly one `entitlements` key,
 * a bounded object of `[a-z0-9_]` flags → booleans. An empty map is valid
 * (revoke-all). Used by the RPC registry validator.
 */
export function validateEntitlementsParams(params: Record<string, unknown>): boolean {
  const keys = Object.keys(params);
  if (keys.length !== 1 || keys[0] !== "entitlements") return false;
  const map = params.entitlements;
  if (!isPlainObject(map)) return false;
  const flagKeys = Object.keys(map);
  if (flagKeys.length > MAX_ENTITLEMENT_FLAGS) return false;
  return flagKeys.every((k) => ENTITLEMENT_FLAG_RE.test(k) && typeof map[k] === "boolean");
}
