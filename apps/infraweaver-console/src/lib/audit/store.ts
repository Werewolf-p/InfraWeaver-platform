// Durable, tamper-evident audit store over a versioned {@link AuditSink}.
//
// Design (see plans/subject-3):
//  - append-only ring buffer: only append + trim-oldest, never rewrite lines;
//  - cap by count (AUDIT_MAX_ENTRIES) AND bytes (AUDIT_MAX_BYTES);
//  - monotonic `seq` + `prevHash`→`hash` chain for tamper-evidence;
//  - all appends serialized through an in-process promise queue so concurrent
//    writers never lose entries; a stale compare-and-swap write (409) re-reads
//    and retries, re-applying our sealed line against the fresh tail.

import { createHash } from "crypto";
import { AuditConflictError, getAuditSink, type AuditSink } from "./sink";
import type {
  AuditAppendInput,
  AuditChainResult,
  AuditPage,
  AuditQuery,
  AuditRecord,
} from "./types";

export const AUDIT_MAX_ENTRIES = 1000;
// Stay well under the ~1 MB ConfigMap object cap (room for metadata + the key).
export const AUDIT_MAX_BYTES = 900_000;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 500;
const WRITE_CONFLICT_RETRIES = 5;

export interface AuditStoreOptions {
  maxEntries?: number;
  maxBytes?: number;
}

export interface AuditStore {
  appendAudit(input: AuditAppendInput): Promise<AuditRecord>;
  queryAudit(query: AuditQuery): Promise<AuditPage>;
  verifyChain(): Promise<AuditChainResult>;
}

/** Canonical string hashed into the chain. Field order is part of the contract. */
function canonicalString(record: Omit<AuditRecord, "hash">): string {
  return [
    record.seq,
    record.timestamp,
    record.action,
    record.category,
    record.severity,
    record.user,
    record.result,
    record.resource ?? "",
    record.target ?? "",
    record.detail,
    record.prevHash ?? "",
  ].join("");
}

function computeHash(record: Omit<AuditRecord, "hash">): string {
  return createHash("sha256").update(canonicalString(record)).digest("hex");
}

function parseLine(line: string): AuditRecord | null {
  try {
    const raw = JSON.parse(line) as Partial<AuditRecord> & { details?: string };
    if (!raw.timestamp || !raw.action) return null;
    return {
      seq: typeof raw.seq === "number" ? raw.seq : 0,
      timestamp: raw.timestamp,
      action: raw.action,
      category: raw.category ?? "other",
      severity: raw.severity ?? "info",
      user: raw.user ?? "unknown",
      result: raw.result === "failure" ? "failure" : "success",
      resource: raw.resource || undefined,
      target: raw.target || undefined,
      // Tolerate legacy lines that used `details` rather than `detail`.
      detail: raw.detail ?? raw.details ?? "",
      ip: raw.ip || undefined,
      userAgent: raw.userAgent || undefined,
      prevHash: raw.prevHash || undefined,
      hash: raw.hash || undefined,
    };
  } catch {
    return null;
  }
}

function parseAll(lines: string[]): AuditRecord[] {
  return lines.map(parseLine).filter((record): record is AuditRecord => record !== null);
}

/** Trim oldest lines until both the count and byte caps are satisfied. */
function trimToCaps(lines: string[], maxEntries: number, maxBytes: number): string[] {
  let trimmed = lines.length > maxEntries ? lines.slice(lines.length - maxEntries) : lines.slice();
  while (trimmed.length > 1 && Buffer.byteLength(trimmed.join("\n")) > maxBytes) {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

function matches(record: AuditRecord, query: AuditQuery): boolean {
  if (query.user && !record.user.toLowerCase().includes(query.user.toLowerCase())) return false;
  if (query.action && !record.action.toLowerCase().includes(query.action.toLowerCase())) return false;
  if (query.category && record.category !== query.category) return false;
  if (query.severity && record.severity !== query.severity) return false;
  if (query.result && record.result !== query.result) return false;
  if (query.resource && !(record.resource ?? "").toLowerCase().includes(query.resource.toLowerCase())) return false;
  if (query.target && !(record.target ?? "").toLowerCase().includes(query.target.toLowerCase())) return false;
  if (query.from && record.timestamp < query.from) return false;
  if (query.to && record.timestamp > query.to) return false;
  if (query.q) {
    const needle = query.q.toLowerCase();
    const haystack = `${record.action} ${record.user} ${record.detail} ${record.resource ?? ""} ${record.target ?? ""}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

/**
 * Build a store bound to a specific sink. The default instance (below) binds the
 * ConfigMap sink lazily; tests inject an in-memory sink to exercise the
 * ring-buffer, chain and serialization logic without a cluster.
 */
export function createAuditStore(sink: AuditSink, options: AuditStoreOptions = {}): AuditStore {
  const maxEntries = options.maxEntries ?? AUDIT_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? AUDIT_MAX_BYTES;

  // Serializes every append in-process so seq/prevHash are always read against
  // the tail our own previous append produced (no lost updates within a pod).
  let writeChain: Promise<unknown> = Promise.resolve();

  async function appendOnce(input: AuditAppendInput): Promise<AuditRecord> {
    let lastError: unknown;
    for (let attempt = 0; attempt < WRITE_CONFLICT_RETRIES; attempt += 1) {
      const snapshot = await sink.read();
      const existing = parseAll(snapshot.lines);
      const last = existing[existing.length - 1];
      const seq = (last?.seq ?? 0) + 1;
      const prevHash = last?.hash;

      const unsealed: Omit<AuditRecord, "hash"> = {
        seq,
        timestamp: input.timestamp,
        action: input.action,
        category: input.category,
        severity: input.severity,
        user: input.user,
        result: input.result,
        resource: input.resource,
        target: input.target,
        detail: input.detail,
        ip: input.ip,
        userAgent: input.userAgent,
        prevHash,
      };
      const sealed: AuditRecord = { ...unsealed, hash: computeHash(unsealed) };

      const nextLines = trimToCaps([...snapshot.lines, JSON.stringify(sealed)], maxEntries, maxBytes);
      try {
        await sink.write(nextLines, snapshot.version);
        return sealed;
      } catch (error) {
        if (error instanceof AuditConflictError) {
          lastError = error;
          continue; // Re-read the fresh tail and re-seal against it.
        }
        throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new AuditConflictError("audit append exhausted retries");
  }

  return {
    appendAudit(input: AuditAppendInput): Promise<AuditRecord> {
      const result = writeChain.then(() => appendOnce(input));
      // Keep the chain alive even if this append rejects, so later appends run.
      writeChain = result.catch(() => undefined);
      return result;
    },

    async queryAudit(query: AuditQuery): Promise<AuditPage> {
      const snapshot = await sink.read();
      const all = parseAll(snapshot.lines);
      const filtered = all.filter((record) => matches(record, query)).sort((a, b) => b.seq - a.seq);

      const afterCursor =
        query.cursor === undefined ? filtered : filtered.filter((record) => record.seq < query.cursor!);
      const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
      const entries = afterCursor.slice(0, limit);
      const nextCursor = afterCursor.length > limit ? entries[entries.length - 1].seq : null;

      return { entries, nextCursor, total: filtered.length };
    },

    async verifyChain(): Promise<AuditChainResult> {
      const snapshot = await sink.read();
      const sealed = parseAll(snapshot.lines)
        .filter((record) => record.hash)
        .sort((a, b) => a.seq - b.seq);

      let prevHash: string | undefined;
      let checked = 0;
      for (const record of sealed) {
        const { hash, ...unsealed } = record;
        const recomputed = computeHash(unsealed);
        if (recomputed !== hash) {
          return { ok: false, checked, brokenSeq: record.seq, reason: "hash mismatch" };
        }
        if (prevHash !== undefined && record.prevHash !== prevHash) {
          return { ok: false, checked, brokenSeq: record.seq, reason: "broken prevHash link" };
        }
        prevHash = hash;
        checked += 1;
      }
      return { ok: true, checked };
    },
  };
}

let _defaultStore: AuditStore | null = null;

function defaultStore(): AuditStore {
  if (!_defaultStore) _defaultStore = createAuditStore(getAuditSink());
  return _defaultStore;
}

/** Durably append a record (serialized + tamper-evident). */
export function appendAudit(input: AuditAppendInput): Promise<AuditRecord> {
  return defaultStore().appendAudit(input);
}

/** Query the durable audit trail (filter + newest-first cursor pagination). */
export function queryAudit(query: AuditQuery): Promise<AuditPage> {
  return defaultStore().queryAudit(query);
}

/** Walk the hash chain and report the first break, if any. */
export function verifyChain(): Promise<AuditChainResult> {
  return defaultStore().verifyChain();
}
