// Shared audit-domain types. Pure — safe to import from server routes, the
// durable store, the query API, and (type-only) client code.

/** Broad domain bucket derived from an action string. */
export type AuditCategory =
  | "user"
  | "rbac"
  | "secret"
  | "cluster"
  | "gitops"
  | "auth"
  | "app"
  | "other";

/** Ranked severity derived from action + result. */
export type AuditSeverity = "info" | "notice" | "warning" | "critical";

export type AuditResult = "success" | "failure";

/**
 * A durable, tamper-evident audit record. `seq`, `prevHash` and `hash` are
 * assigned by the store when the record is sealed and persisted — callers of
 * `auditLog()` never supply them.
 */
export interface AuditRecord {
  seq: number;
  timestamp: string;
  action: string;
  category: AuditCategory;
  severity: AuditSeverity;
  user: string;
  result: AuditResult;
  resource?: string;
  target?: string;
  detail: string;
  ip?: string;
  userAgent?: string;
  prevHash?: string;
  hash?: string;
}

/**
 * The fields a writer supplies. The store derives `seq`/`prevHash`/`hash`, so
 * they are omitted here.
 */
export type AuditAppendInput = Omit<AuditRecord, "seq" | "prevHash" | "hash">;

export interface AuditQuery {
  user?: string;
  action?: string;
  category?: AuditCategory;
  severity?: AuditSeverity;
  result?: AuditResult;
  resource?: string;
  target?: string;
  /** Inclusive lower bound (ISO timestamp). */
  from?: string;
  /** Inclusive upper bound (ISO timestamp). */
  to?: string;
  /** Free-text match across action/user/detail/resource/target. */
  q?: string;
  /** Return records with `seq` strictly below this value (newest-first paging). */
  cursor?: number;
  /** Page size. */
  limit?: number;
}

export interface AuditPage {
  entries: AuditRecord[];
  nextCursor: number | null;
  total: number;
}

export interface AuditChainResult {
  ok: boolean;
  /** Total sealed (hash-bearing) records that were verified. */
  checked: number;
  /** First `seq` at which the chain failed, when `ok` is false. */
  brokenSeq?: number;
  reason?: string;
}
