import "server-only";
import { makeCoreApi } from "@/lib/kube-client";
import { AddonHttpError } from "./errors";
import { isK8sNotFound, isTransientApiError } from "./k8s-errors";
import { compareConnectorVersions } from "./connector-version";
import { buildConnectorPackage } from "./connector-package";
import {
  CHANNEL_IDS,
  canPromoteChannel,
  getChannel,
  isReleaseChannel,
  type ReleaseChannel,
} from "./channels";

/**
 * The runtime "release board": the channel → Connector-version map the update
 * sweep targets each site with. This is DATA, not code — it lives in a ConfigMap
 * (`infraweaver-iwsl-channels`) so an operator can promote/roll back a channel at
 * runtime with NO rebuild, exactly the editability the link store gets. It reuses
 * the same ConfigMap-backed, optimistic-concurrency pattern as `iwsl-link-store`.
 *
 * Seeding: on first read a channel with no stored version defaults to the version
 * bundled in THIS console image. So a fresh cluster starts with every channel
 * pointing at the shipped Connector, and the board only diverges once an operator
 * promotes/rolls back a channel. Seeding is side-effect-free (a read never writes)
 * so viewing the board needs no write permission.
 *
 * Each mutation records the actor + timestamp per entry, mirroring how the link
 * store stamps `rotationPolicy`/`entitlements` changes.
 */

const CONSOLE_NAMESPACE = process.env.CONSOLE_NAMESPACE ?? process.env.POD_NAMESPACE ?? "infraweaver-console";
const CONFIGMAP_NAME = process.env.IWSL_CHANNELS_CONFIGMAP_NAME ?? "infraweaver-iwsl-channels";

/** One channel's pinned version plus the audit trail of who last set it. */
export interface ChannelEntry {
  version: string;
  updatedAt: string;
  updatedBy: string;
}

/** The full board: every channel's entry. */
export type ChannelRegistryDetail = Record<ReleaseChannel, ChannelEntry>;

interface ChannelsConfigMap {
  metadata?: { resourceVersion?: string };
  data?: Record<string, string | undefined>;
}

interface LoadedRegistry {
  /** Stored entries only — channels absent here fall back to the seed on read. */
  stored: Partial<Record<ReleaseChannel, ChannelEntry>>;
  resourceVersion?: string;
}

function isChannelEntry(value: unknown): value is ChannelEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.version === "string" &&
    typeof entry.updatedAt === "string" &&
    typeof entry.updatedBy === "string"
  );
}

function safeParseRegistry(value: string | undefined): Partial<Record<ReleaseChannel, ChannelEntry>> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Partial<Record<ReleaseChannel, ChannelEntry>> = {};
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (isReleaseChannel(key) && isChannelEntry(entry)) out[key] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

async function readRegistry(): Promise<LoadedRegistry> {
  const core = makeCoreApi();
  try {
    const cm = (await core.readNamespacedConfigMap({
      name: CONFIGMAP_NAME,
      namespace: CONSOLE_NAMESPACE,
    })) as ChannelsConfigMap;
    return {
      stored: safeParseRegistry(cm.data?.channels),
      resourceVersion: cm.metadata?.resourceVersion,
    };
  } catch (err) {
    if (isK8sNotFound(err)) return { stored: {} };
    throw err;
  }
}

async function writeRegistry(
  entries: ChannelRegistryDetail,
  resourceVersion: string | undefined,
): Promise<void> {
  const core = makeCoreApi();
  const body = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: {
      name: CONFIGMAP_NAME,
      namespace: CONSOLE_NAMESPACE,
      labels: {
        "app.kubernetes.io/managed-by": "infraweaver-console",
        "infraweaver.io/component": "iwsl",
      },
      ...(resourceVersion ? { resourceVersion } : {}),
    },
    data: {
      channels: JSON.stringify(entries),
      updatedAt: new Date().toISOString(),
    },
  };
  if (resourceVersion) {
    await core.replaceNamespacedConfigMap({ name: CONFIGMAP_NAME, namespace: CONSOLE_NAMESPACE, body });
  } else {
    await core.createNamespacedConfigMap({ namespace: CONSOLE_NAMESPACE, body });
  }
}

/** The version every channel seeds to on first read: the console's bundled Connector. */
async function seedVersion(): Promise<string> {
  return (await buildConnectorPackage()).version;
}

/** Fill any un-stored channel with the seed version, yielding a complete board. */
function withSeedDefaults(
  stored: Partial<Record<ReleaseChannel, ChannelEntry>>,
  seed: string,
): ChannelRegistryDetail {
  const out = {} as ChannelRegistryDetail;
  for (const id of CHANNEL_IDS) {
    out[id] = stored[id] ?? { version: seed, updatedAt: "", updatedBy: "system:default" };
  }
  return out;
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * The channel → version map the update sweep resolves each site's target from.
 * Seeds any un-set channel to the bundled version. Read-only — never writes.
 */
export async function getChannelRegistry(): Promise<Record<ReleaseChannel, string>> {
  const detail = await getChannelRegistryDetail();
  const out = {} as Record<ReleaseChannel, string>;
  for (const id of CHANNEL_IDS) out[id] = detail[id].version;
  return out;
}

/** The full board (version + who/when), for the operator-facing release-board UI. */
export async function getChannelRegistryDetail(): Promise<ChannelRegistryDetail> {
  const [{ stored }, seed] = await Promise.all([readRegistry(), seedVersion()]);
  return withSeedDefaults(stored, seed);
}

// ── Mutations ──────────────────────────────────────────────────────────────

/** Same 6-attempt full-jitter retry budget the link store uses on this CM class. */
const MUTATE_MAX_ATTEMPTS = 6;
const MUTATE_BACKOFF_BASE_MS = 25;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function backoffDelayMs(retry: number): number {
  return Math.floor(Math.random() * (MUTATE_BACKOFF_BASE_MS * 2 ** retry));
}

function isWriteConflict(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /409|conflict|already\s*exists/i.test(message);
}

function isRetriableMutateError(err: unknown): boolean {
  return isWriteConflict(err) || isTransientApiError(err);
}

/**
 * Read-modify-write on the channel board with the same optimistic-concurrency
 * retry the link store applies: each attempt re-reads the freshest board (seeded)
 * and re-applies the mutator, so a concurrent promote/rollback merges rather than
 * clobbering. The mutator returns the NEXT complete board; it must be free of side
 * effects beyond producing that value (it can run more than once).
 */
async function mutateRegistry(
  mutator: (current: ChannelRegistryDetail) => ChannelRegistryDetail,
): Promise<ChannelRegistryDetail> {
  let lastErr: unknown;
  const seed = await seedVersion();
  for (let attempt = 0; attempt < MUTATE_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(backoffDelayMs(attempt - 1));
    try {
      const { stored, resourceVersion } = await readRegistry();
      const next = mutator(withSeedDefaults(stored, seed));
      await writeRegistry(next, resourceVersion);
      return next;
    } catch (err) {
      lastErr = err;
      if (!isRetriableMutateError(err) || attempt === MUTATE_MAX_ATTEMPTS - 1) throw err;
    }
  }
  throw lastErr ?? new Error("Failed to persist channel registry");
}

/** Reject anything the Connector version comparator can't parse (garbage guard). */
function assertParseableVersion(version: string): void {
  // `compareConnectorVersions` returns null for an unparseable core; a version
  // that compares to itself is therefore known-good. Reuses the sweep's own
  // comparator so "valid version" means exactly what the sweep can order.
  if (compareConnectorVersions(version, version) === null) {
    throw new AddonHttpError(`"${version}" is not a valid Connector version`, 400);
  }
}

function stamp(version: string, actor: string): ChannelEntry {
  return { version, updatedAt: new Date().toISOString(), updatedBy: actor };
}

/**
 * Pin `channel` to an explicit `version` (validated). The general "point this
 * channel at this build" control — used to publish a new build onto alpha, or as
 * the primitive `rollbackChannel` delegates to.
 */
export async function setChannelVersion(
  channel: ReleaseChannel,
  version: string,
  actor: string,
): Promise<ChannelRegistryDetail> {
  if (!isReleaseChannel(channel)) throw new AddonHttpError("Unknown release channel", 400);
  assertParseableVersion(version);
  return mutateRegistry((current) => ({ ...current, [channel]: stamp(version, actor) }));
}

/**
 * Promote `from`'s current version onto `to`. Direction is enforced by
 * `canPromoteChannel`: only alpha→beta and beta→prod are allowed, so a build
 * always soaks on the next-more-stable channel first. Sets `to` = `from`'s
 * version verbatim (the whole point of a promotion is to move the exact tested
 * bits forward), re-stamped with the promoting actor.
 */
export async function promoteChannel(
  from: ReleaseChannel,
  to: ReleaseChannel,
  actor: string,
): Promise<ChannelRegistryDetail> {
  if (!isReleaseChannel(from) || !isReleaseChannel(to)) {
    throw new AddonHttpError("Unknown release channel", 400);
  }
  if (!canPromoteChannel(from, to)) {
    throw new AddonHttpError(
      `Cannot promote ${getChannel(from).label} → ${getChannel(to).label}: ` +
        `a build may only be promoted one rung toward production (alpha→beta, beta→prod)`,
      400,
    );
  }
  return mutateRegistry((current) => ({ ...current, [to]: stamp(current[from].version, actor) }));
}

/**
 * Roll `channel` back to an explicit prior `version` (validated). Distinct from
 * promotion: rollback carries no direction rule — an operator may pin any channel
 * to any known-good earlier build to back out a bad one.
 */
export async function rollbackChannel(
  channel: ReleaseChannel,
  version: string,
  actor: string,
): Promise<ChannelRegistryDetail> {
  if (!isReleaseChannel(channel)) throw new AddonHttpError("Unknown release channel", 400);
  assertParseableVersion(version);
  return mutateRegistry((current) => ({ ...current, [channel]: stamp(version, actor) }));
}
