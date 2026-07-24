/**
 * Payment tiers — the declarative table that maps a tier to the entitlement
 * flags it grants, plus the console-authoritative resolution helpers.
 *
 * THE ONE PLACE TO EDIT. Adding a tier, renaming one, or moving a feature
 * between tiers is a change to `TIERS` only. Every other layer (the signed
 * push, the link-record mirror, the gate, the UI selector) derives from this
 * table, so tiers stay in lockstep with no schema change.
 *
 * SECURITY: this module is the console's authoritative source of "what a site is
 * entitled to". Gating derives flags from the tier stored on the console link
 * record — never from anything a WordPress site self-reports. A site can only
 * RECEIVE a dual-signed flag map (see `entitlements.ts` / `iwsl-managed-ops.ts`);
 * it has no path to raise its own tier, because the tier lives here on the
 * console and the flag map only lands on the plugin because it arrived signed.
 *
 * Pure module (no server deps) so it is importable from the isomorphic RPC
 * registry, the server-only managed-ops mutator, the client UI, and unit tests.
 */

import {
  ENTITLEMENT_FLAGS,
  normalizeEntitlements,
  type EntitlementFlag,
  type EntitlementMap,
} from "./entitlements";

/**
 * Tier identifiers, ordered from base to top. Persisted verbatim on the link
 * record (`ExternalSiteRecord.tier`), so keep them stable: renaming an id is a
 * data migration, whereas changing a `displayName` is free.
 */
export const TIER_IDS = ["free", "care_basic", "care_pro", "care_ultimate"] as const;
export type TierId = (typeof TIER_IDS)[number];

/** A single tier: its identity, where it ranks, and the flags it turns on. */
export interface TierDefinition {
  readonly id: TierId;
  /** Operator-facing name; aligned with the demo `Care …` plan names for cohesion. */
  readonly displayName: string;
  /** Monotonic rank — 0 is the base/free tier, higher grants more. Drives ordering. */
  readonly rank: number;
  readonly description: string;
  /** The entitlement flags this tier turns ON. Everything else is off. */
  readonly grants: readonly EntitlementFlag[];
}

/**
 * The tier table. Edit HERE to add a tier or move a feature between tiers.
 *
 * Ladder: Free (base) → Basic → Pro → Ultimate. The persisted `id`s are kept
 * stable (`free`/`care_basic`/`care_pro`/`care_ultimate`) so renaming the
 * customer-facing `displayName` is a free change with no data migration.
 *
 * Feature placement (deliberate):
 *   - Basic grants NOTHING — a named entry rung with no paid features.
 *   - `image_optimization` (lossless on-site image conversion) unlocks at Pro
 *     and is inherited by Ultimate. It is the first tier ABOVE Basic, so Basic
 *     and Free can never invoke it — the strict gate the plugin enforces locally
 *     mirrors this table exactly.
 */
export const TIERS: Readonly<Record<TierId, TierDefinition>> = {
  free: {
    id: "free",
    displayName: "Free",
    rank: 0,
    description: "Base tier — no paid features. The state a revoked site returns to.",
    grants: [],
  },
  care_basic: {
    id: "care_basic",
    displayName: "Basic",
    rank: 1,
    description: "Entry rung — a named home for a linked site with no paid features yet.",
    grants: [],
  },
  care_pro: {
    id: "care_pro",
    displayName: "Pro",
    rank: 2,
    description:
      "First tier above Basic — unlocks the on-site tool set: lossless image optimization, database cleanup, SMTP delivery + email log, and the 301 redirect manager, plus the Plus feature set, priority support, and advanced analytics.",
    grants: [
      "plus",
      "priority_support",
      "advanced_analytics",
      "image_optimization",
      "db_optimization",
      "email_delivery",
      "redirect_manager",
      "page_cache",
      "lazy_load",
      "duplicate_post",
      "svg_upload",
      "maintenance_mode",
      "scheduled_db_cleanup",
      "broken_link_scan",
      "seo_audit",
      "speed_pack",
      "media_protection",
      "response_scan",
      "elementor_blocks",
      "media_folders",
      "security_headers",
    ],
  },
  care_ultimate: {
    id: "care_ultimate",
    displayName: "Ultimate",
    rank: 3,
    description: "Everything in Pro plus white-label branding (custom login + admin).",
    grants: [
      "plus",
      "priority_support",
      "advanced_analytics",
      "white_label",
      "image_optimization",
      "db_optimization",
      "email_delivery",
      "redirect_manager",
      "page_cache",
      "lazy_load",
      "duplicate_post",
      "svg_upload",
      "maintenance_mode",
      "scheduled_db_cleanup",
      "broken_link_scan",
      "seo_audit",
      "auto_convert",
      "activity_log",
      "cdn_rewrite",
      "speed_pack",
      "statistics",
      "cookie_consent",
      "seo_suite",
      "media_protection",
      "response_scan",
      "elementor_blocks",
      "media_folders",
      "security_headers",
    ],
  },
};

/** The tier a site holds when none is assigned (or after a revoke). */
export const DEFAULT_TIER_ID: TierId = "free";

/** Narrow arbitrary input to a known tier id. */
export function isTierId(value: unknown): value is TierId {
  return typeof value === "string" && (TIER_IDS as readonly string[]).includes(value);
}

/** The definition for a tier id (throws on an unknown id — callers narrow first). */
export function getTier(tierId: TierId): TierDefinition {
  return TIERS[tierId];
}

/** All tiers, ascending by rank — the order the UI selector renders them in. */
export function listTiers(): readonly TierDefinition[] {
  return TIER_IDS.map((id) => TIERS[id]).sort((a, b) => a.rank - b.rank);
}

/**
 * The full boolean flag map a tier implies — EVERY known flag set explicitly to
 * true (granted) or false (not granted). Explicit `false`s make a downgrade
 * unambiguous both in the console mirror and on the wire: the plugin does a
 * wholesale replace, so pushing the complete map guarantees a demoted flag is
 * turned off rather than left dangling. `normalizeEntitlements` still runs at the
 * emitter as the single wire-bound guard.
 */
export function deriveEntitlementsForTier(tierId: TierId): EntitlementMap {
  const granted = new Set<EntitlementFlag>(getTier(tierId).grants);
  const out: EntitlementMap = {};
  for (const flag of ENTITLEMENT_FLAGS) {
    out[flag] = granted.has(flag);
  }
  return out;
}

/**
 * Minimal shape the resolvers read — the authoritative console record fields.
 * `entitlements.flags` is optional so both the server record (`SiteEntitlements`,
 * flags required) and the client link view (flags optional) satisfy it.
 */
export interface TierBearingRecord {
  readonly tier?: TierId;
  readonly entitlements?: { flags?: EntitlementMap };
}

/**
 * The AUTHORITATIVE tier for a site, read from the console link record. Defaults
 * to Free when unassigned or when a stored value is somehow not a known tier.
 * Reads only console-side state — never a plugin self-report.
 */
export function resolveTierId(record: TierBearingRecord | undefined): TierId {
  return record?.tier && isTierId(record.tier) ? record.tier : DEFAULT_TIER_ID;
}

/**
 * The AUTHORITATIVE entitlement map the console should gate on. Derived from the
 * assigned tier when present; for a legacy record that carries a mirrored flag
 * map but no tier, it falls back to that mirror (itself only ever written after a
 * signed accept). Either way the value comes from the console record, so a
 * WordPress response can never influence what the console believes is granted.
 */
export function resolveEntitlements(record: TierBearingRecord | undefined): EntitlementMap {
  if (record?.tier && isTierId(record.tier)) return deriveEntitlementsForTier(record.tier);
  return normalizeEntitlements(record?.entitlements?.flags ?? {});
}

/**
 * Whether a site holds a given entitlement flag, resolved from the authoritative
 * console record. This is the function console feature-gating should call.
 */
export function siteHasEntitlement(record: TierBearingRecord | undefined, flag: EntitlementFlag): boolean {
  return resolveEntitlements(record)[flag] === true;
}

/**
 * The LOWEST-rank tier that grants a flag, or `null` when no tier does. Powers the
 * `TierGate` upsell copy ("Included in Pro") — the cheapest plan that unlocks a
 * locked feature. `listTiers()` is ascending by rank, so the first match is the
 * cheapest. Pure lookup over the same `TIERS` table.
 */
export function lowestTierGranting(flag: EntitlementFlag): TierDefinition | null {
  return listTiers().find((tier) => tier.grants.includes(flag)) ?? null;
}
