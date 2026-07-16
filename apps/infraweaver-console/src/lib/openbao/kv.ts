import "server-only";

/**
 * Shared OpenBao KV v2 helpers — SERVER ONLY.
 *
 * Extracts the vaultFetch pattern duplicated across `@/lib/udm/store`,
 * `@/lib/nas/store` and `@/lib/app-accounts/store`: env-driven address/token,
 * `X-Vault-Token` header, request timeout, KV v2 `data/data` unwrapping, and
 * 404 → null reads so callers degrade to a "not configured" state instead of
 * throwing.
 *
 * Paths are LOGICAL KV paths (e.g. `platform/udm`); the mount and the
 * `data/` / `metadata/` API prefixes are added here. Segments are validated
 * against a safe grammar so a caller can never inject `../` or hop mounts.
 *
 * The console's OpenBao token needs the matching create/read/update/delete
 * capabilities on `secret/data/<path>` (see infra `bootstrap-openbao.sh`).
 */

const KV_MOUNT = process.env.OPENBAO_KV_MOUNT || "secret";
const VAULT_TIMEOUT_MS = Number(process.env.OPENBAO_TIMEOUT_MS) || 10_000;

/** Request timeout for direct (non-KV) OpenBao calls — exported for the token collector. */
export const OPENBAO_REQUEST_TIMEOUT_MS = VAULT_TIMEOUT_MS;

// Each path segment is a vault key component; constrain to a safe grammar
// (mirrors app-accounts/store SAFE_SEGMENT/SAFE_USERNAME) rather than trusting
// callers not to inject `../` or a mount hop.
const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

function assertSafeLogicalPath(logicalPath: string): string {
  const segments = logicalPath.split("/");
  if (segments.length === 0 || segments.some((segment) => !SAFE_PATH_SEGMENT.test(segment))) {
    throw new Error("unsafe OpenBao KV path");
  }
  return logicalPath;
}

/**
 * Resolve the OpenBao address + token from env. Exported so sibling collectors
 * (secrets/openbao-token) can reuse the exact same resolution for non-KV
 * endpoints (`/v1/auth/token/*`) without re-reading env or drifting.
 */
export function vaultAuth(): { addr: string; token: string } {
  const addr = (process.env.OPENBAO_ADDR || process.env.VAULT_ADDR || "").replace(/\/+$/, "");
  const token = process.env.OPENBAO_TOKEN || process.env.VAULT_TOKEN || "";
  if (!addr) throw new Error("OPENBAO_ADDR/VAULT_ADDR is not configured");
  if (!token) throw new Error("OPENBAO_TOKEN/VAULT_TOKEN is not configured");
  return { addr, token };
}

/** `logicalPath` is a KV logical path; the mount + `data/` prefix are added here. */
async function vaultFetch(logicalPath: string, init: RequestInit): Promise<Response> {
  const { addr, token } = vaultAuth();
  const path = assertSafeLogicalPath(logicalPath);
  try {
    return await fetch(`${addr}/v1/${KV_MOUNT}/data/${path}`, {
      ...init,
      signal: AbortSignal.timeout(VAULT_TIMEOUT_MS),
      headers: { "X-Vault-Token": token, ...(init.headers ?? {}) },
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`OpenBao request timed out after ${VAULT_TIMEOUT_MS}ms`);
    }
    throw err;
  }
}

/**
 * Read a KV v2 secret's inner data object, or `null` when the secret does not
 * exist (404). Returns `unknown` — callers validate/narrow (zod is the house
 * convention, see app-accounts/store).
 */
export async function readKv(logicalPath: string): Promise<unknown | null> {
  const res = await vaultFetch(logicalPath, { method: "GET" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`OpenBao read ${logicalPath} failed: ${res.status}`);
  const body = (await res.json()) as { data?: { data?: unknown } };
  return body.data?.data ?? null;
}

/**
 * Write a KV v2 secret. A KV v2 write replaces the WHOLE secret object at the
 * path, so callers own the full shape (read-modify-write when merging).
 */
export async function writeKv(logicalPath: string, data: Record<string, unknown>): Promise<void> {
  const res = await vaultFetch(logicalPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  });
  if (!res.ok) throw new Error(`OpenBao write ${logicalPath} failed: ${res.status}`);
}

/**
 * Best-effort delete of a secret's METADATA (all versions), so a revoked
 * credential does not linger. Never throws — an orphaned secret is harmless
 * and cleanup must never fail a revoke (mirrors app-accounts deleteCredential).
 */
export async function deleteKvMetadata(logicalPath: string): Promise<void> {
  try {
    const { addr, token } = vaultAuth();
    const path = assertSafeLogicalPath(logicalPath);
    await fetch(`${addr}/v1/${KV_MOUNT}/metadata/${path}`, {
      method: "DELETE",
      headers: { "X-Vault-Token": token },
      signal: AbortSignal.timeout(VAULT_TIMEOUT_MS),
    });
  } catch {
    /* best-effort: never fail the caller on cleanup */
  }
}
