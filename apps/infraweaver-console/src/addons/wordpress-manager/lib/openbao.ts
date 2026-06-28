/**
 * Minimal OpenBao / Vault KV v2 client, self-contained to the addon so it carries
 * its own secret persistence. Reads address and token from the environment; never
 * logs secret values. KV v2 wraps data under `{ data: { data: {...} } }`.
 */
import { ServiceUnavailableError } from "./errors";

// Read the token per-call (in requireVault) so a rotated token is picked up
// without a process restart; addr/mount are stable configuration.
const KV_MOUNT = process.env.WORDPRESS_VAULT_MOUNT || "secret";
const VAULT_TIMEOUT_MS = Number(process.env.WORDPRESS_VAULT_TIMEOUT_MS) || 10_000;

function requireVault(): { addr: string; token: string } {
  const addr = process.env.OPENBAO_ADDR || process.env.VAULT_ADDR || "";
  const token = process.env.OPENBAO_TOKEN || process.env.VAULT_TOKEN || "";
  if (!addr) throw new Error("OPENBAO_ADDR/VAULT_ADDR is not configured");
  if (!token) throw new Error("OPENBAO_TOKEN/VAULT_TOKEN is not configured");
  return { addr: addr.replace(/\/+$/, ""), token };
}

/** Strip the leading `<mount>/` from a logical path using a literal (not regex)
 * comparison, so a mount name containing regex metacharacters is handled safely. */
function stripMount(logicalPath: string): string {
  const prefix = `${KV_MOUNT}/`;
  return logicalPath.startsWith(prefix) ? logicalPath.slice(prefix.length) : logicalPath;
}

/** Convert a logical path `secret/wordpress/<site>/db` to the KV v2 data API path. */
function kvDataPath(logicalPath: string): string {
  return `${KV_MOUNT}/data/${stripMount(logicalPath)}`;
}

/** fetch with a bounded timeout so an unreachable vault can't hang provisioning. */
async function vaultFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VAULT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    // Label the abort so an operator sees "vault timed out", not "operation aborted".
    if (err instanceof Error && err.name === "AbortError") {
      throw new ServiceUnavailableError(`vault request timed out after ${VAULT_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function writeSecret(logicalPath: string, data: Record<string, string>): Promise<void> {
  const { addr, token } = requireVault();
  const res = await vaultFetch(`${addr}/v1/${kvDataPath(logicalPath)}`, {
    method: "POST",
    headers: { "X-Vault-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  });
  if (!res.ok) throw new Error(`vault write ${logicalPath} failed: ${res.status}`);
}

export async function readSecret(logicalPath: string): Promise<Record<string, string> | null> {
  const { addr, token } = requireVault();
  const res = await vaultFetch(`${addr}/v1/${kvDataPath(logicalPath)}`, {
    headers: { "X-Vault-Token": token },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`vault read ${logicalPath} failed: ${res.status}`);
  const body = (await res.json()) as { data?: { data?: Record<string, string> } };
  return body.data?.data ?? null;
}

export async function deleteSecret(logicalPath: string): Promise<void> {
  const { addr, token } = requireVault();
  const metaPath = `${KV_MOUNT}/metadata/${stripMount(logicalPath)}`;
  const res = await vaultFetch(`${addr}/v1/${metaPath}`, {
    method: "DELETE",
    headers: { "X-Vault-Token": token },
  });
  if (!res.ok && res.status !== 404) throw new Error(`vault delete ${logicalPath} failed: ${res.status}`);
}
