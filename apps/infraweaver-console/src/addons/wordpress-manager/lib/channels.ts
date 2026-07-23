/**
 * Release channels — the declarative table that names each Connector release
 * train (prod / beta / alpha) and where it ranks on the stability ladder, plus
 * the console-authoritative resolution helpers.
 *
 * THE ONE PLACE TO EDIT. Adding a channel, renaming one, or re-ordering the
 * ladder is a change to `CHANNELS` only. Every other layer (the per-site link
 * mirror, the runtime channel→version registry, the update sweep's per-site
 * targeting, the UI selector) derives from this table, so channels stay in
 * lockstep with no schema change.
 *
 * ORTHOGONAL to tiers (`tiers.ts`). A tier is *what a site is entitled to*; a
 * channel is *which Connector release train the site rides*. The two are
 * assigned and stored independently on the same link record.
 *
 * SECURITY: like the tier, a channel is CONSOLE-AUTHORITATIVE. It lives on the
 * console link record and a WordPress site can never self-select it. Assigning a
 * channel is pure console bookkeeping (no wire push); the Connector only ever
 * receives a new version through the operator-initiated, signed update sweep,
 * which carries the version the channel resolves to. A site therefore has no
 * path to move itself onto a more-advanced (less-stable) train.
 *
 * Pure module (no server deps) so it is importable from the isomorphic RPC
 * registry, the server-only managed-ops mutator, the client UI, and unit tests.
 */

/**
 * Channel identifiers, ordered from most-stable to least. Persisted verbatim on
 * the link record (`ExternalSiteRecord.channel`), so keep them stable: renaming
 * an id is a data migration, whereas changing a `label` is free.
 */
export const CHANNEL_IDS = ["prod", "beta", "alpha"] as const;
export type ReleaseChannel = (typeof CHANNEL_IDS)[number];

/** A single channel: its identity, operator-facing label, ladder rank, and blurb. */
export interface ChannelDefinition {
  readonly id: ReleaseChannel;
  /** Operator-facing name for the selector. */
  readonly label: string;
  /**
   * Monotonic rank — 0 is `prod` (the most stable, the default). HIGHER means
   * LESS stable / further AHEAD of prod (`beta` = 1, `alpha` = 2). Drives ordering
   * and the promotion direction rule (a channel may only be promoted one rung
   * toward prod: alpha→beta, beta→prod).
   */
  readonly rank: number;
  readonly blurb: string;
}

/**
 * The channel table. Edit HERE to add a channel or re-order the ladder.
 *
 * Ladder: prod (base, most stable) → beta → alpha (furthest ahead, least
 * stable). The persisted `id`s are kept stable so renaming a `label` is a free
 * change with no data migration.
 */
export const CHANNELS: Readonly<Record<ReleaseChannel, ChannelDefinition>> = {
  prod: {
    id: "prod",
    label: "Production",
    rank: 0,
    blurb: "The stable release train. The channel a site rides when none is assigned.",
  },
  beta: {
    id: "beta",
    label: "Beta",
    rank: 1,
    blurb: "One rung ahead of production — release candidates soaking before they promote to prod.",
  },
  alpha: {
    id: "alpha",
    label: "Alpha",
    rank: 2,
    blurb: "The bleeding edge — newest builds, least soak time. For canary sites only.",
  },
};

/** The channel a site rides when none is assigned. */
export const DEFAULT_CHANNEL: ReleaseChannel = "prod";

/** Narrow arbitrary input to a known release channel. */
export function isReleaseChannel(value: unknown): value is ReleaseChannel {
  return typeof value === "string" && (CHANNEL_IDS as readonly string[]).includes(value);
}

/** The definition for a channel id (throws on an unknown id — callers narrow first). */
export function getChannel(channelId: ReleaseChannel): ChannelDefinition {
  return CHANNELS[channelId];
}

/** All channels, ascending by rank (prod → beta → alpha) — the UI selector order. */
export function listChannels(): readonly ChannelDefinition[] {
  return CHANNEL_IDS.map((id) => CHANNELS[id]).sort((a, b) => a.rank - b.rank);
}

/** Minimal shape the resolver reads — the authoritative console record field. */
export interface ChannelBearingRecord {
  readonly channel?: ReleaseChannel;
}

/**
 * The AUTHORITATIVE channel for a site, read from the console link record.
 * Defaults to prod when unassigned or when a stored value is somehow not a known
 * channel. Reads only console-side state — never a plugin self-report.
 */
export function resolveChannel(record: ChannelBearingRecord | undefined): ReleaseChannel {
  return record?.channel && isReleaseChannel(record.channel) ? record.channel : DEFAULT_CHANNEL;
}

/**
 * Whether `from` may be promoted onto `to`. Promotion moves EXACTLY one rung
 * toward prod (more stable): alpha→beta and beta→prod. Every other pairing —
 * same channel, the wrong direction (prod→beta), or skipping a rung
 * (alpha→prod) — is rejected, so a build always soaks on the next-more-stable
 * channel before it can reach the one after.
 */
export function canPromoteChannel(from: ReleaseChannel, to: ReleaseChannel): boolean {
  return CHANNELS[from].rank === CHANNELS[to].rank + 1;
}
