/**
 * NAS folder browsing and creation — SERVER ONLY.
 *
 * A share is the unit the NAS exports; a *folder* is the unit InfraWeaver mounts.
 * This module is what lets an operator walk into `infraweaver/` , create `media/`,
 * and hand that one directory to any number of workloads.
 *
 * It is provider-agnostic: `listNasFolders` / `createNasFolder` dispatch on the
 * provider's `kind`, so adding a backend means adding one adapter here and
 * nothing anywhere else. Providers with no filesystem API (`generic-smb`,
 * `generic-nfs`) raise `NasFolderUnsupportedError`, which the route renders as a
 * 501 rather than an empty, misleading folder list.
 *
 * Path safety: every share-relative path is run through `normalizeSubfolder`
 * before it is joined onto the share's absolute path, and `joinNasPath`
 * re-validates. See `@/lib/nas/paths` — that is the traversal boundary.
 *
 * Error contract matches `@/lib/nas/discovery`: an ordinary failure degrades to
 * `[]` for reads, but a TLS certificate problem THROWS so the caller can raise a
 * 409 certificate challenge rather than silently reporting "no folders".
 */

import { synologyLogin, type SynologyConn } from "@/lib/nas/discovery";
import { fetchNasService, isNasCertificateError } from "@/lib/nas/pinned-fetch";
import { joinNasPath, normalizeSubfolder, subfolderSegments } from "@/lib/nas/paths";
import {
  TRUENAS_EEXIST,
  truenasRequest,
  truenasRequestOrThrow,
  type TruenasConnection,
} from "@/lib/nas/truenas-api";
import type { NasProviderKind, StoredNasCredentials } from "@/lib/nas/store";

/** Refuse to render an unbounded directory into a dropdown. */
const MAX_FOLDER_ENTRIES = 500;
/** New folders are group-writable; the CSI service accounts get explicit ACEs. */
const NEW_FOLDER_MODE = "770";

/** A directory directly beneath the browsed path. */
export interface NasFolderEntry {
  /** Base name, e.g. `movies`. */
  name: string;
  /** Share-relative path, e.g. `media/movies` — what the mount flow consumes. */
  subfolder: string;
}

export class NasFolderUnsupportedError extends Error {
  readonly code = "NAS_FOLDER_UNSUPPORTED";
  constructor(kind: NasProviderKind) {
    super(`Provider kind '${kind}' has no filesystem API for browsing or creating folders`);
    this.name = "NasFolderUnsupportedError";
  }
}

export class NasShareNotFoundError extends Error {
  readonly code = "NAS_SHARE_NOT_FOUND";
  constructor(share: string) {
    super(`Share '${share}' does not exist on this NAS`);
    this.name = "NasShareNotFoundError";
  }
}

/** The connection shape each adapter needs, assembled from a resolved provider. */
export interface NasFolderTarget {
  kind: NasProviderKind;
  host: string;
  port: number;
  tlsFingerprint256?: string;
  wizardHost?: string;
}

function truenasConn(target: NasFolderTarget, credentials: StoredNasCredentials): TruenasConnection {
  return {
    host: target.host,
    port: target.port,
    apiKey: credentials.apiKey ?? "",
    tlsFingerprint256: target.tlsFingerprint256,
    wizardHost: target.wizardHost,
  };
}

function synologyConn(target: NasFolderTarget, credentials: StoredNasCredentials): SynologyConn {
  return {
    host: target.host,
    port: target.port,
    tlsFingerprint256: target.tlsFingerprint256,
    wizardHost: target.wizardHost,
    user: credentials.username ?? "",
    password: credentials.password ?? "",
  };
}

// ---------------------------------------------------------------------------
// TrueNAS
// ---------------------------------------------------------------------------

interface TruenasSmbShare {
  name: string;
  path: string;
}

interface TruenasDirEntry {
  name: string;
  path: string;
  type: "DIRECTORY" | "FILE" | "SYMLINK" | "OTHER";
}

/**
 * Absolute dataset path backing an SMB share (e.g. `infraweaver` →
 * `/mnt/Main/infraweaver`). Resolved from the appliance, never from the caller —
 * it is the base every folder path is anchored to.
 */
async function truenasSharePath(conn: TruenasConnection, share: string): Promise<string> {
  const shares = await truenasRequestOrThrow<TruenasSmbShare[]>(conn, "/sharing/smb");
  const match = Array.isArray(shares) ? shares.find((entry) => entry.name === share) : undefined;
  if (!match?.path) throw new NasShareNotFoundError(share);
  return match.path;
}

/** `filesystem.listdir` takes only `{path}` — it rejects `query-filters`, so we filter here. */
async function truenasListDir(conn: TruenasConnection, absolutePath: string): Promise<TruenasDirEntry[]> {
  const entries = await truenasRequestOrThrow<TruenasDirEntry[]>(conn, "/filesystem/listdir", {
    method: "POST",
    body: { path: absolutePath },
  });
  return Array.isArray(entries) ? entries : [];
}

async function truenasMkdir(conn: TruenasConnection, absolutePath: string): Promise<boolean> {
  const res = await truenasRequest(conn, "/filesystem/mkdir", {
    method: "POST",
    body: { path: absolutePath, options: { mode: NEW_FOLDER_MODE, raise_chmod_error: false } },
  });
  if (res.ok) return true;
  // `mkdir` is not idempotent: an existing directory is a 422 with errno EEXIST.
  // That is the success case for "ensure this folder exists".
  if (res.errno === TRUENAS_EEXIST) return false;
  throw new Error(res.message ?? `Could not create folder on the NAS (HTTP ${res.status})`);
}

// ---------------------------------------------------------------------------
// Synology
// ---------------------------------------------------------------------------

interface SynoListResponse {
  success: boolean;
  error?: { code: number };
  data?: { files?: Array<{ name: string; path: string; isdir?: boolean }> };
}

async function synologyEntry<T>(conn: SynologyConn, params: Record<string, string>): Promise<T> {
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
  const res = await fetchNasService(
    `https://${conn.host}:${conn.port}/webapi/entry.cgi?${query}`,
    { timeoutMs: 8000 },
    { pin: conn.tlsFingerprint256, wizardHost: conn.wizardHost },
  );
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Public, provider-agnostic surface
// ---------------------------------------------------------------------------

/** Absolute path of a share on the appliance. Needed for NFS exports and ACL grants. */
export async function resolveNasSharePath(
  target: NasFolderTarget,
  credentials: StoredNasCredentials,
  share: string,
): Promise<string> {
  if (target.kind === "truenas") return truenasSharePath(truenasConn(target, credentials), share);
  if (target.kind === "synology") return `/${share}`;
  throw new NasFolderUnsupportedError(target.kind);
}

/**
 * Directories directly beneath `share/subfolder`. Returns `[]` on an ordinary
 * failure; re-throws TLS certificate errors so the caller can challenge.
 */
export async function listNasFolders(
  target: NasFolderTarget,
  credentials: StoredNasCredentials,
  share: string,
  subfolder: string,
): Promise<NasFolderEntry[]> {
  const relative = normalizeSubfolder(subfolder);
  const child = (name: string): NasFolderEntry => ({
    name,
    subfolder: relative ? `${relative}/${name}` : name,
  });

  try {
    if (target.kind === "truenas") {
      const conn = truenasConn(target, credentials);
      if (!conn.apiKey) return [];
      const base = await truenasSharePath(conn, share);
      const entries = await truenasListDir(conn, joinNasPath(base, relative));
      return entries
        .filter((entry) => entry.type === "DIRECTORY")
        .slice(0, MAX_FOLDER_ENTRIES)
        .map((entry) => child(entry.name))
        .sort((left, right) => left.name.localeCompare(right.name));
    }
    if (target.kind === "synology") {
      const conn = synologyConn(target, credentials);
      const sid = await synologyLogin(conn);
      if (!sid) return [];
      const folderPath = relative ? `/${share}/${relative}` : `/${share}`;
      const data = await synologyEntry<SynoListResponse>(conn, {
        api: "SYNO.FileStation.List",
        version: "2",
        method: "list",
        folder_path: folderPath,
        filetype: "dir",
        SID: sid,
      });
      if (!data.success) return [];
      return (data.data?.files ?? [])
        .slice(0, MAX_FOLDER_ENTRIES)
        .map((file) => child(file.name))
        .sort((left, right) => left.name.localeCompare(right.name));
    }
  } catch (error) {
    if (isNasCertificateError(error) || error instanceof NasShareNotFoundError) throw error;
    return [];
  }
  throw new NasFolderUnsupportedError(target.kind);
}

/**
 * Create `share/subfolder`, including any missing parent directories.
 *
 * Idempotent: a folder that already exists is not an error, it simply is not
 * reported as created. Returns the share-relative paths that were newly made.
 */
export async function createNasFolder(
  target: NasFolderTarget,
  credentials: StoredNasCredentials,
  share: string,
  subfolder: string,
): Promise<{ created: string[] }> {
  const segments = subfolderSegments(subfolder);
  if (segments.length === 0) throw new Error("Cannot create the share root");

  if (target.kind === "truenas") {
    const conn = truenasConn(target, credentials);
    if (!conn.apiKey) throw new Error("TrueNAS API key is not configured for this provider");
    const base = await truenasSharePath(conn, share);
    const created: string[] = [];
    // `filesystem.mkdir` has no `parents` flag, so walk the chain shallow-first.
    for (const segment of segments) {
      if (await truenasMkdir(conn, joinNasPath(base, segment))) created.push(segment);
    }
    return { created };
  }

  if (target.kind === "synology") {
    const conn = synologyConn(target, credentials);
    const sid = await synologyLogin(conn);
    if (!sid) throw new Error("Synology login failed — check the stored credentials");
    const relative = normalizeSubfolder(subfolder);
    const parts = relative.split("/");
    const leaf = parts.pop() as string;
    const parent = parts.length ? `/${share}/${parts.join("/")}` : `/${share}`;
    const data = await synologyEntry<{ success: boolean; error?: { code: number } }>(conn, {
      api: "SYNO.FileStation.CreateFolder",
      version: "2",
      method: "create",
      folder_path: parent,
      name: leaf,
      // Create missing parents, and treat an existing folder as success.
      force_parent: "true",
    });
    // 408 = "file/folder already exists" in the FileStation error table.
    if (!data.success && data.error?.code !== 408) {
      throw new Error(`Synology refused to create the folder (error ${data.error?.code ?? "unknown"})`);
    }
    return { created: data.success ? [relative] : [] };
  }

  throw new NasFolderUnsupportedError(target.kind);
}
