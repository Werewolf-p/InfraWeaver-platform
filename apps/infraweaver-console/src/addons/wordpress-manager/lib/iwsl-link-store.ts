import "server-only";
import { makeCoreApi } from "@/lib/kube-client";
import { isK8sNotFound } from "./k8s-errors";

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
 * Read-modify-write with one optimistic-concurrency retry on 409, mirroring
 * access-store. The mutator returns its result and may edit `sites` in place
 * on the freshly loaded copy.
 */
export async function mutateExternalSites<T>(
  mutator: (sites: ExternalSiteRecord[]) => T,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const state = await readSites();
    const result = mutator(state.sites);
    try {
      await writeSites(state);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const conflict = /409|conflict/i.test(message);
      if (!conflict || attempt === 1) throw err;
    }
  }
  throw new Error("Failed to persist IWSL site state");
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
