/**
 * OpenBao-backed storage for the UDM connector config — SERVER ONLY.
 *
 * The connector authenticates to the local UDM with a UniFi OS username +
 * password (this firmware rejects API keys on the Network API), plus a pinned
 * cert fingerprint. The password is a secret, so the whole config lives in
 * OpenBao at `secret/platform/udm` (KV v2) — never in git or a static env var.
 * It is read at request time so credentials saved through the settings UI are
 * live immediately, without a pod restart. The console's OpenBao token needs
 * `create,update,read` on `secret/data/platform/udm` (see infra
 * `bootstrap-openbao.sh`).
 */

import type { UdmConfig } from "@/lib/udm/types";

const KV_MOUNT = process.env.OPENBAO_KV_MOUNT || "secret";
const UDM_LOGICAL_PATH = "platform/udm";
const VAULT_TIMEOUT_MS = Number(process.env.OPENBAO_TIMEOUT_MS) || 10_000;

/** Shape persisted in OpenBao. Hyphenated keys match the existing seed convention. */
interface StoredUdm {
  host: string;
  username: string;
  password: string;
  "cert-sha256": string;
  site?: string;
}

function vaultAuth(): { addr: string; token: string } {
  const addr = (process.env.OPENBAO_ADDR || process.env.VAULT_ADDR || "").replace(/\/+$/, "");
  const token = process.env.OPENBAO_TOKEN || process.env.VAULT_TOKEN || "";
  if (!addr) throw new Error("OPENBAO_ADDR/VAULT_ADDR is not configured");
  if (!token) throw new Error("OPENBAO_TOKEN/VAULT_TOKEN is not configured");
  return { addr, token };
}

const dataApiPath = `${KV_MOUNT}/data/${UDM_LOGICAL_PATH}`;

async function vaultFetch(init: RequestInit): Promise<Response> {
  const { addr, token } = vaultAuth();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VAULT_TIMEOUT_MS);
  try {
    return await fetch(`${addr}/v1/${dataApiPath}`, {
      ...init,
      signal: controller.signal,
      headers: { "X-Vault-Token": token, ...(init.headers ?? {}) },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`OpenBao request timed out after ${VAULT_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the stored connector config, or null when unset or incomplete. A missing
 * secret (404) returns null rather than throwing, so callers degrade to the
 * "not configured" state.
 */
export async function readStoredUdmConfig(): Promise<UdmConfig | null> {
  const res = await vaultFetch({ method: "GET" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`OpenBao read udm config failed: ${res.status}`);
  const body = (await res.json()) as { data?: { data?: Partial<StoredUdm> } };
  const stored = body.data?.data;
  if (!stored?.host || !stored.username || !stored.password || !stored["cert-sha256"]) return null;
  return {
    host: stored.host,
    username: stored.username,
    password: stored.password,
    fingerprintSha256: stored["cert-sha256"],
    site: stored.site || "default",
  };
}

/**
 * Persist the connector config. KV v2 write replaces the whole secret, which is
 * safe here because the path is dedicated to the UDM connector.
 */
export async function writeStoredUdmConfig(config: {
  host: string;
  username: string;
  password: string;
  fingerprintSha256: string;
  site: string;
}): Promise<void> {
  const data: StoredUdm = {
    host: config.host,
    username: config.username,
    password: config.password,
    "cert-sha256": config.fingerprintSha256,
    site: config.site,
  };
  const res = await vaultFetch({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
  });
  if (!res.ok) throw new Error(`OpenBao write udm config failed: ${res.status}`);
}
