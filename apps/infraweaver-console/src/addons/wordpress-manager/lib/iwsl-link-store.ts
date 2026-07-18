import "server-only";
import { makeCoreApi } from "@/lib/kube-client";
import type { SlhdsaAlg } from "@/lib/iwsl";
import { isK8sNotFound, isTransientApiError } from "./k8s-errors";

/**
 * Persistence for IWSL external-site link records (design §5, §12.5).
 *
 * Non-secret link state lives in one ConfigMap in the console namespace
 * (`infraweaver-iwsl-sites`), mirroring the ConfigMap-backed pattern of
 * access-store/feedback-store — human-inspectable via kubectl, optimistic
 * concurrency on writes. The single-use enrollment secrets (§5, sensitive for
 * their 15-minute life) live apart in a k8s Secret keyed by site id and are
 * burned on verify.
 */

const CONSOLE_NAMESPACE = process.env.CONSOLE_NAMESPACE ?? process.env.POD_NAMESPACE ?? "infraweaver-console";
const CONFIGMAP_NAME = process.env.IWSL_SITES_CONFIGMAP_NAME ?? "infraweaver-iwsl-sites";
const ENROLL_SECRET_NAME = process.env.IWSL_ENROLL_SECRET_NAME ?? "infraweaver-iwsl-enroll-secrets";

export type ExternalSiteState = "pending" | "active" | "quarantined";

export interface ExternalSiteRecord {
  siteId: string;
  /** Operator-facing display name. */
  name: string;
  /** Callback origin — the https URL IW pulls the enroll-proof from (§5). */
  url: string;
  state: ExternalSiteState;
  /**
   * §5 step 3: operator visually compared IW-PK/WP-PK fingerprints against the
   * plugin. Mandatory-manual for external sites — commands stay blocked until
   * this is true, even once ACTIVE.
   */
  fingerprintConfirmed: boolean;
  createdAt: string;
  createdBy: string;
  /** Set while a downloadable bundle is outstanding. */
  bundleIssuedAt?: string;
  bundleExpiresAt?: string;
  activatedAt?: string;
  /** Pinned WP public key (b64url) once ACTIVE. */
  wpPk?: string;
  /** WP key epoch + monotonic floor (§8); 1 after enrollment. */
  kid: number;
  epochFloor: number;
  /** IW key epoch the site pinned from its bundle. */
  iwKid: number;
  /**
   * SLH-DSA parameter set the site pinned at enrollment, i.e. the set the
   * console must sign this link's commands with. Absent means the historical
   * default "slh-dsa-192s" (the ~47s-sign set); "slh-dsa-192f" is the fast-sign
   * set a re-enrolled/new link pins. Per-link so the fleet migrates one link at
   * a time with no flag-day.
   */
  iwAlg?: SlhdsaAlg;
  /** §12.5 — last verify-pull attempt and its outcome. */
  lastVerify?: { at: string; ok: boolean; reason?: string };
  /** §12.5 — verify/enrollment rejections seen for this site. */
  rejections: number;
  /** §6.3 — last command seq issued by IW; the plugin rejects seq <= last_seq. */
  lastSeq?: number;
  /** §8 — in-flight WP-key rotation, persisted so a lost ack can resume. */
  pendingRotation?: {
    rotationId: string;
    newKid: number;
    newWpPk: string | null;
    phase: "prepare" | "verify";
    startedTs: number;
    deadlineTs: number;
  } | null;
  /**
   * §8 — outcome of the last WP signing-key reroll, for operator visibility.
   * `outcome` mirrors the rotation driver's terminal result: "confirmed" (new
   * epoch live), "aborted" (failed / rolled back — old key retained), "pending"
   * (in-flight, will resume). Written from the console-driven rotation run and
   * also reconciled from the plugin's own signed `last_reroll` (in health.check /
   * debug.status), so it stays truthful even if a reroll ran out of band or the
   * console lost the ack. `at` is ISO8601; the record keeps only the most recent.
   */
  lastReroll?: {
    at: string;
    outcome: "confirmed" | "aborted" | "pending";
    kid: number;
    reason?: string;
  };
  /** Last signed health.check outcome (§12.5 diagnostics). */
  lastHealth?: { at: string; ok: boolean; roundtripMs?: number; reason?: string };
  /**
   * Running Connector version, read from the last signature-verified
   * `health.check` (§5.1 update signal). Only ever written from a verified
   * response, so it can't be spoofed down by a MITM to hide an out-of-date
   * plugin. Absent until the link has answered at least one health.check.
   */
  connectorVersion?: string;
  /**
   * §5.1 — true for links to IW-provisioned cluster sites, enrolled over
   * k8s exec instead of the public bundle/verify flow. `siteName` is the
   * WordPress-manager site the record belongs to.
   */
  managed?: boolean;
  siteName?: string;
  /**
   * Cert backbone (defense-in-depth): SPKI pin-set (base64 SHA-256 of the
   * site's TLS SubjectPublicKeyInfo, `sha256//` values). Captured at the
   * signature-verified §5 proof-pull, so it's proof-authenticated rather than
   * blind TOFU. When present, external command dispatch fails closed unless the
   * served chain matches — catching a hijacked-DNS/mis-issued-CA endpoint at the
   * TLS handshake, before the PQ-signed body is sent. External (HTTPS) links
   * only; managed links use in-cluster exec and carry no pin. Backup pins let a
   * key rotation overlap old+new.
   */
  pinnedSpki?: string[];
  /** When `pinnedSpki` was last observed/updated from a verified exchange. */
  spkiObservedAt?: string;
  /**
   * Clone / identity-crisis binding (§5, §12.5). The link's identity is
   * `siteId` + the site's own canonical URL. `canonicalUrl` is anchored from the
   * FIRST signature-verified self-report (the plugin's live `home_url()` inside a
   * verified health.check/debug.status) and rebound only on operator re-confirm —
   * a MITM can't forge it, and a clone carrying valid keys still reports its own
   * (different) URL. When a valid-key link later self-reports a URL that differs
   * from `canonicalUrl`, `identitySuspended` flips true: a soft safe mode that
   * blocks state-changing ops (key rotation, plugin update) while leaving the
   * read-only health/debug diagnostics live, until an operator re-confirms the
   * identity (or quarantines/kills a suspected clone). Distinct from
   * `quarantined`, which cuts the signing path entirely.
   */
  canonicalUrl?: string;
  identitySuspended?: boolean;
  identityAlert?: {
    reason: "url-changed" | "stopped-reporting";
    observedUrl: string;
    boundUrl: string;
    at: string;
  };
}

interface SitesConfigMap {
  metadata?: { resourceVersion?: string };
  data?: Record<string, string | undefined>;
}

interface LoadedSites {
  sites: ExternalSiteRecord[];
  resourceVersion?: string;
}

function safeParseSites(value: string | undefined): ExternalSiteRecord[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as ExternalSiteRecord[]) : [];
  } catch {
    return [];
  }
}

async function readSites(): Promise<LoadedSites> {
  const core = makeCoreApi();
  try {
    const cm = (await core.readNamespacedConfigMap({
      name: CONFIGMAP_NAME,
      namespace: CONSOLE_NAMESPACE,
    })) as SitesConfigMap;
    return { sites: safeParseSites(cm.data?.sites), resourceVersion: cm.metadata?.resourceVersion };
  } catch (err) {
    if (isK8sNotFound(err)) return { sites: [] };
    throw err;
  }
}

async function writeSites(state: LoadedSites): Promise<void> {
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
      ...(state.resourceVersion ? { resourceVersion: state.resourceVersion } : {}),
    },
    data: {
      sites: JSON.stringify(state.sites),
      updatedAt: new Date().toISOString(),
    },
  };
  if (state.resourceVersion) {
    await core.replaceNamespacedConfigMap({ name: CONFIGMAP_NAME, namespace: CONSOLE_NAMESPACE, body });
  } else {
    await core.createNamespacedConfigMap({ namespace: CONSOLE_NAMESPACE, body });
  }
}

export async function listExternalSites(): Promise<ExternalSiteRecord[]> {
  return (await readSites()).sites;
}

export async function getExternalSite(siteId: string): Promise<ExternalSiteRecord | null> {
  return (await readSites()).sites.find((s) => s.siteId === siteId) ?? null;
}

/**
 * How many times a conflicting read-modify-write is retried before giving up.
 * Sized for the connector update sweep's worst case: up to SWEEP_CONCURRENCY (4)
 * lanes each do multiple writes (allocateSeq + version persist) to this one
 * ConfigMap in near-lockstep, so a loser can be bounced several times. 3 attempts
 * left ~1 site/run losing every retry and failing on a 409; 6 attempts, spread by
 * the full-jitter backoff (ceilings 25..400ms), reliably resolve that contention.
 */
const MUTATE_MAX_ATTEMPTS = 6;
/** Base for the exponential backoff (ms); actual wait is full-jittered below. */
const MUTATE_BACKOFF_BASE_MS = 25;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Full-jitter exponential backoff. `retry` is 0-based (the wait BEFORE the
 * n-th retry). Jitter is essential here: the hourly health sweep persists every
 * fleet site's result in near-lockstep, so a fixed backoff would just re-collide
 * them into the same retry window (thundering herd on the one ConfigMap).
 */
function backoffDelayMs(retry: number): number {
  const ceiling = MUTATE_BACKOFF_BASE_MS * 2 ** retry;
  return Math.floor(Math.random() * ceiling);
}

/** A mutate failure worth another attempt: an optimistic-lock 409 or a transient API drop. */
function isRetriableMutateError(err: unknown): boolean {
  return isWriteConflict(err) || isTransientApiError(err);
}

/**
 * Read-modify-write with retry, mirroring access-store. Retries on both an
 * optimistic-concurrency 409 AND a transient kube-apiserver connection drop —
 * the two failure modes the hourly fleet health sweep hits when every site
 * persists its result in near-lockstep. Each attempt re-reads the latest
 * ConfigMap (fresh resourceVersion) and re-applies the mutator to it, so a
 * concurrent replace that lands between our read and our write is merged rather
 * than clobbered. Retries are spread by a full-jitter backoff so the writers
 * don't lock-step back into the same window. The mutator may edit `sites` in
 * place on the freshly loaded copy; because it can run more than once it must be
 * free of side effects beyond that edit (the append mutators dedupe by url).
 */
export async function mutateExternalSites<T>(
  mutator: (sites: ExternalSiteRecord[]) => T,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MUTATE_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(backoffDelayMs(attempt - 1));
    try {
      const state = await readSites();
      const result = mutator(state.sites);
      await writeSites(state);
      return result;
    } catch (err) {
      lastErr = err;
      if (!isRetriableMutateError(err) || attempt === MUTATE_MAX_ATTEMPTS - 1) throw err;
    }
  }
  throw lastErr ?? new Error("Failed to persist IWSL site state");
}

// ── Enrollment secrets (§5 — single-use, sensitive, burned on verify) ────────

interface EnrollSecretsSecret {
  metadata?: { resourceVersion?: string };
  data?: Record<string, string | undefined>;
}

interface LoadedEnrollSecrets {
  data: Record<string, string>;
  resourceVersion?: string;
}

async function readEnrollSecrets(): Promise<LoadedEnrollSecrets> {
  const core = makeCoreApi();
  try {
    const secret = (await core.readNamespacedSecret({
      name: ENROLL_SECRET_NAME,
      namespace: CONSOLE_NAMESPACE,
    })) as EnrollSecretsSecret;
    const data: Record<string, string> = {};
    for (const [key, value] of Object.entries(secret.data ?? {})) {
      if (typeof value === "string") data[key] = Buffer.from(value, "base64").toString("utf8");
    }
    return { data, resourceVersion: secret.metadata?.resourceVersion };
  } catch (err) {
    if (isK8sNotFound(err)) return { data: {} };
    throw err;
  }
}

async function writeEnrollSecrets(data: Record<string, string>, resourceVersion?: string): Promise<void> {
  const core = makeCoreApi();
  const body = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: ENROLL_SECRET_NAME,
      namespace: CONSOLE_NAMESPACE,
      labels: {
        "app.kubernetes.io/managed-by": "infraweaver-console",
        "infraweaver.io/component": "iwsl",
      },
      ...(resourceVersion ? { resourceVersion } : {}),
    },
    type: "Opaque",
    stringData: data,
    // Replace wholesale: stringData merges into data on write, so removed keys
    // must be cleared via an emptied data map.
    data: {},
  };
  if (resourceVersion) {
    await core.replaceNamespacedSecret({ name: ENROLL_SECRET_NAME, namespace: CONSOLE_NAMESPACE, body });
  } else {
    await core.createNamespacedSecret({ namespace: CONSOLE_NAMESPACE, body });
  }
}

function isWriteConflict(err: unknown): boolean {
  // 409 covers both optimistic-replace Conflict and create AlreadyExists —
  // either way a re-read gets us the current state to retry against.
  const message = err instanceof Error ? err.message : String(err);
  return /409|conflict|already\s*exists/i.test(message);
}

/**
 * Read-modify-write on the enroll-secret map with one retry on conflict —
 * pinned to resourceVersion so two concurrent enrollments for different sites
 * can't silently drop each other's key (last-writer-wins).
 */
async function mutateEnrollSecrets(
  mutator: (data: Record<string, string>) => Record<string, string> | null,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data, resourceVersion } = await readEnrollSecrets();
    const next = mutator(data);
    if (next === null) return; // no change needed
    try {
      await writeEnrollSecrets(next, resourceVersion);
      return;
    } catch (err) {
      if (!isWriteConflict(err) || attempt === 1) throw err;
    }
  }
  throw new Error("Failed to persist IWSL enrollment secrets");
}

/** Persist (or overwrite) the outstanding enroll secret for a site (b64url). */
export async function putEnrollSecret(siteId: string, enrollSecretB64u: string): Promise<void> {
  await mutateEnrollSecrets((data) => ({ ...data, [siteId]: enrollSecretB64u }));
}

export async function getEnrollSecret(siteId: string): Promise<string | null> {
  const { data } = await readEnrollSecrets();
  return data[siteId] ?? null;
}

/** Burn the single-use secret (§5 step 3 / record deletion). Idempotent. */
export async function deleteEnrollSecret(siteId: string): Promise<void> {
  await mutateEnrollSecrets((data) => {
    if (!(siteId in data)) return null;
    return Object.fromEntries(Object.entries(data).filter(([key]) => key !== siteId));
  });
}
