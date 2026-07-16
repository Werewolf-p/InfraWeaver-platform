/**
 * Shared, CLIENT-SAFE types + pure logic for the Secret & GitOps lifecycle view.
 *
 * This module MUST NOT import `server-only`, `fetch`-driven collectors, or any
 * node-only dependency: it is imported by both the server collector
 * (`lifecycle-collector.ts`) and the client `SecretHealthSummary` component
 * (and, per the coordination contract, by Subject 2's observability board).
 *
 * All severity/coverage/token classification lives here as pure functions so it
 * can be unit-tested without mocking OpenBao, Kubernetes, or GitHub.
 */

export type Severity = "ok" | "warn" | "critical";

// ── Thresholds (named constants, no magic numbers) ───────────────────────────
const SECONDS_PER_DAY = 24 * 60 * 60;
/** OpenBao token with ≤ 7 days of TTL is a critical time-bomb (the 24-ES outage). */
export const TOKEN_TTL_CRITICAL_SECONDS = 7 * SECONDS_PER_DAY;
/** ≤ 30 days of TTL is a warning — renew before it becomes critical. */
export const TOKEN_TTL_WARN_SECONDS = 30 * SECONDS_PER_DAY;

// ── Data shapes (the `SecretLifecycleReport` is Subject 5's public contract) ──

export interface TokenStatus {
  /** True when `/v1/auth/token/lookup-self` answered; false degrades safely. */
  available: boolean;
  ttlSeconds: number | null;
  expireTime: string | null;
  renewable: boolean;
  policies: string[];
  error?: string;
}

export interface ReferencedKey {
  /** KV logical path (ES `remoteRef.key` or `dataFrom.extract.key`). */
  path: string;
  /** Specific key within the path, or null for a whole-path `dataFrom` extract. */
  property: string | null;
}

export interface EsLifecycle {
  name: string;
  namespace: string;
  ready: boolean;
  /** "Retain" | "Delete" | "Merge" | "" (unset). */
  deletionPolicy: string;
  targetSecret: string;
  referencedKeys: ReferencedKey[];
  /** Human-readable "path/property" identifiers absent from OpenBao. */
  missingKeys: string[];
  /** Retain + ≥1 missing referenced key ⇒ the whole secret fails to sync. */
  isRetainTrap: boolean;
  lastSync: string | null;
  message: string | null;
}

export interface CatalogCoverage {
  app: string;
  path: string;
  declaredKeys: string[];
  seededKeys: string[];
  referencedKeys: string[];
  /** declared − seeded (fresh-install seed gaps). */
  missingKeys: string[];
  /** referenced − declared (an ES points at a key no catalog declares). */
  undeclaredReferencedKeys: string[];
}

export interface PublicMirrorStatus {
  available: boolean;
  workflowName: string | null;
  status: string | null; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | null
  updatedAt: string | null;
  htmlUrl: string | null;
  error?: string;
}

export interface OpenBaoSeal {
  available: boolean;
  initialized: boolean;
  sealed: boolean;
  standby: boolean;
  version: string;
}

export interface ArgoSecretCorrelation {
  app: string;
  namespace: string;
  health: string;
  sync: string;
  /** ES names in the same namespace that are not Ready — the likely cause. */
  notReadyExternalSecrets: string[];
}

export interface SecretLifecycleReport {
  severity: Severity;
  generatedAt: string;
  /** Reflects SECRET_REMEDIATION_WRITE_ENABLED so the UI can gate re-mint/re-seed. */
  remediationWriteEnabled: boolean;
  token: TokenStatus;
  openbao: OpenBaoSeal;
  externalSecrets: {
    available: boolean;
    items: EsLifecycle[];
    total: number;
    notReady: number;
    retainTraps: number;
  };
  catalogCoverage: {
    available: boolean;
    items: CatalogCoverage[];
    totalMissing: number;
  };
  publicMirror: PublicMirrorStatus;
  argoCorrelations: ArgoSecretCorrelation[];
}

// ── Pure classifiers ─────────────────────────────────────────────────────────

/** Severity of the OpenBao token purely from its TTL. Unreachable ⇒ warn. */
export function classifyTokenTtl(token: Pick<TokenStatus, "available" | "ttlSeconds">): Severity {
  if (!token.available) return "warn";
  if (token.ttlSeconds === null) return "warn";
  if (token.ttlSeconds <= TOKEN_TTL_CRITICAL_SECONDS) return "critical";
  if (token.ttlSeconds <= TOKEN_TTL_WARN_SECONDS) return "warn";
  return "ok";
}

/** Parse the `/v1/auth/token/lookup-self` payload into the token fields. Pure. */
export function parseTokenLookupData(raw: unknown): Omit<TokenStatus, "available" | "error"> {
  const data = (raw as { data?: Record<string, unknown> } | null)?.data ?? {};
  const ttlRaw = data.ttl;
  const ttlSeconds = typeof ttlRaw === "number" && Number.isFinite(ttlRaw) ? ttlRaw : null;
  const expireTime = typeof data.expire_time === "string" ? data.expire_time : null;
  const renewable = data.renewable === true;
  const policies = Array.isArray(data.policies)
    ? data.policies.filter((p): p is string => typeof p === "string")
    : [];
  return { ttlSeconds, expireTime, renewable, policies };
}

/** Extract every OpenBao key an ExternalSecret references (`data[]` + `dataFrom[]`). */
export function extractReferencedKeys(spec: {
  data?: Array<{ remoteRef?: { key?: string; property?: string } }>;
  dataFrom?: Array<{ extract?: { key?: string } }>;
} | undefined): ReferencedKey[] {
  const keys: ReferencedKey[] = [];
  for (const entry of spec?.data ?? []) {
    const key = entry.remoteRef?.key;
    if (key) keys.push({ path: key, property: entry.remoteRef?.property ?? null });
  }
  for (const entry of spec?.dataFrom ?? []) {
    const key = entry.extract?.key;
    if (key) keys.push({ path: key, property: null });
  }
  return keys;
}

/** True when `deletionPolicy: Retain` combines with ≥1 missing referenced key. */
export function isRetainPolicy(deletionPolicy: string): boolean {
  return deletionPolicy.trim().toLowerCase() === "retain";
}

export function detectRetainTrap(deletionPolicy: string, missingKeyCount: number): boolean {
  return isRetainPolicy(deletionPolicy) && missingKeyCount > 0;
}

/** Human-readable identifier for a referenced key (`path` or `path/property`). */
export function referencedKeyId(key: ReferencedKey): string {
  return key.property ? `${key.path}/${key.property}` : key.path;
}

/**
 * Compare a catalog app's declared keys against what OpenBao has seeded and
 * what ExternalSecrets reference. Pure set arithmetic.
 */
export function diffCatalogCoverage(
  declaredKeys: readonly string[],
  seededKeys: readonly string[],
  referencedKeys: readonly string[],
): { missingKeys: string[]; undeclaredReferencedKeys: string[] } {
  const seededSet = new Set(seededKeys);
  const declaredSet = new Set(declaredKeys);
  return {
    missingKeys: declaredKeys.filter((key) => !seededSet.has(key)),
    undeclaredReferencedKeys: Array.from(new Set(referencedKeys)).filter((key) => !declaredSet.has(key)),
  };
}

// ── Roll-up severity for the banner + nav badge ──────────────────────────────

export interface SeveritySignals {
  token: Pick<TokenStatus, "available" | "ttlSeconds">;
  openbaoAvailable: boolean;
  sealed: boolean;
  esNotReady: number;
  retainTraps: number;
  missingCatalogKeys: number;
  mirrorFailing: boolean;
}

/**
 * Single glanceable state. Critical when: OpenBao is reachable AND sealed, or
 * the token is expired/≤7d, or a Retain-trap exists, or an ES is not Ready.
 * Warn on ≤30d TTL, missing catalog keys, or a failing public mirror.
 */
export function computeSeverity(signals: SeveritySignals): Severity {
  const tokenSeverity = classifyTokenTtl(signals.token);
  if (signals.openbaoAvailable && signals.sealed) return "critical";
  if (tokenSeverity === "critical") return "critical";
  if (signals.retainTraps > 0) return "critical";
  if (signals.esNotReady > 0) return "critical";

  if (tokenSeverity === "warn") return "warn";
  if (signals.missingCatalogKeys > 0) return "warn";
  if (signals.mirrorFailing) return "warn";
  return "ok";
}

/** UI metadata for a severity — shared by the page banner and the summary card. */
export const SEVERITY_META: Record<Severity, { label: string; badgeClass: string; dotClass: string }> = {
  ok: {
    label: "Healthy",
    badgeClass: "text-green-400 bg-green-500/10 border-green-500/20",
    dotClass: "bg-green-400",
  },
  warn: {
    label: "Needs attention",
    badgeClass: "text-yellow-400 bg-yellow-500/10 border-yellow-500/20",
    dotClass: "bg-yellow-400",
  },
  critical: {
    label: "Critical",
    badgeClass: "text-red-400 bg-red-500/10 border-red-500/20",
    dotClass: "bg-red-400",
  },
};
