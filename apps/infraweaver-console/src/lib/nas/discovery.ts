/**
 * NAS discovery + credential-probe adapters — SERVER ONLY.
 *
 * Extracted from the `shares`/`folders` route handlers so both built-in (env)
 * and dynamically-added (OpenBao) providers share one code path, and so the
 * "save & test" flow in the providers route can validate credentials against a
 * live NAS before persisting them.
 *
 * Every outbound call goes through `fetchInternalService`, which pins requests
 * to the SSRF allowlist; the host is always taken from a resolved provider
 * config (never raw user input) and is separately allowlist-checked by callers.
 */

import { fetchInternalService } from "@/lib/insecure-fetch";
import type { StoredNasCredentials } from "@/lib/nas/store";

export interface NasShare {
  name: string;
  desc?: string;
  path: string;
}

export interface NasFolder {
  name: string;
  path: string;
}

export interface SynologyConn {
  host: string;
  port: number;
  user: string;
  password: string;
}

export interface TruenasConn {
  host: string;
  apiKey: string;
}

const PROBE_TIMEOUT_MS = 5000;

export async function synologyLogin(conn: SynologyConn): Promise<string | null> {
  const user = encodeURIComponent(conn.user);
  const pass = encodeURIComponent(conn.password);
  if (!conn.user || !conn.password) return null;
  try {
    const res = await fetchInternalService(
      `https://${conn.host}:${conn.port}/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=login&account=${user}&passwd=${pass}&session=FileStation&format=sid`,
      { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
      { allowInsecureTls: true },
    );
    const data = (await res.json()) as { success: boolean; data?: { sid: string } };
    return data.success ? data.data?.sid ?? null : null;
  } catch {
    return null;
  }
}

export async function synologyListShares(conn: SynologyConn): Promise<NasShare[]> {
  const sid = await synologyLogin(conn);
  if (!sid) return [];
  try {
    const res = await fetchInternalService(
      `https://${conn.host}:${conn.port}/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list_share&SID=${sid}`,
      { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
      { allowInsecureTls: true },
    );
    const data = (await res.json()) as {
      success: boolean;
      data?: { shares: Array<{ name: string; additional?: { real_path?: string }; desc?: string }> };
    };
    if (!data.success) return [];
    return (data.data?.shares ?? []).map((share) => ({
      name: share.name,
      desc: share.desc ?? "",
      path: share.additional?.real_path ?? `/${share.name}`,
    }));
  } catch {
    return [];
  }
}

export async function synologyListFolders(conn: SynologyConn, share: string): Promise<NasFolder[]> {
  const sid = await synologyLogin(conn);
  if (!sid) return [];
  try {
    const folderPath = encodeURIComponent(`/${share}`);
    const res = await fetchInternalService(
      `https://${conn.host}:${conn.port}/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list&folder_path=${folderPath}&filetype=dir&SID=${sid}`,
      { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
      { allowInsecureTls: true },
    );
    const data = (await res.json()) as { success: boolean; data?: { files: Array<{ name: string; path: string }> } };
    if (!data.success) return [];
    return (data.data?.files ?? []).map((file) => ({ name: file.name, path: file.path }));
  } catch {
    return [];
  }
}

export async function truenasListShares(conn: TruenasConn): Promise<NasShare[]> {
  if (!conn.apiKey) return [];
  try {
    const res = await fetchInternalService(
      `https://${conn.host}/api/v2/sharing/smb`,
      { headers: { Authorization: `Bearer ${conn.apiKey}` }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
      { allowInsecureTls: true },
    );
    if (!res.ok) return [];
    const shares = (await res.json()) as Array<{ name: string; path: string }>;
    return shares.map((share) => ({ name: share.name, path: share.path }));
  } catch {
    return [];
  }
}

export async function truenasListFolders(conn: TruenasConn, share: string): Promise<NasFolder[]> {
  if (!conn.apiKey) return [];
  try {
    const res = await fetchInternalService(
      `https://${conn.host}/api/v2/pool/dataset?type=FILESYSTEM&limit=50`,
      { headers: { Authorization: `Bearer ${conn.apiKey}` }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
      { allowInsecureTls: true },
    );
    if (!res.ok) return [];
    const datasets = (await res.json()) as Array<{ name: string; mountpoint?: { value?: string } }>;
    return datasets
      .filter((dataset) => dataset.name.toLowerCase().includes(share.toLowerCase()))
      .map((dataset) => ({
        name: dataset.name.split("/").pop() ?? dataset.name,
        path: dataset.mountpoint?.value ?? `/${dataset.name}`,
      }));
  } catch {
    return [];
  }
}

export interface ProbeTarget {
  host: string;
  port: number;
  kind: "synology" | "truenas" | "generic-smb" | "generic-nfs";
}

/**
 * Prove the given credentials work against the live NAS before they are
 * persisted. Mirrors the UDM connector "save & test" behaviour: a save that
 * cannot authenticate is rejected rather than stored.
 *
 * `generic-smb`/`generic-nfs` have no HTTP API to authenticate against, so they
 * are accepted without a live check (host-based auth is validated at mount).
 */
export async function probeNasCredentials(
  target: ProbeTarget,
  credentials: StoredNasCredentials,
): Promise<{ ok: boolean; error?: string }> {
  if (target.kind === "synology") {
    if (!credentials.username || !credentials.password) {
      return { ok: false, error: "username and password are required" };
    }
    const sid = await synologyLogin({
      host: target.host,
      port: target.port,
      user: credentials.username,
      password: credentials.password,
    });
    return sid ? { ok: true } : { ok: false, error: "Synology login failed — check host and credentials" };
  }
  if (target.kind === "truenas") {
    if (!credentials.apiKey) return { ok: false, error: "API key is required" };
    try {
      const res = await fetchInternalService(
        `https://${target.host}/api/v2/system/info`,
        { headers: { Authorization: `Bearer ${credentials.apiKey}` }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
        { allowInsecureTls: true },
      );
      return res.ok
        ? { ok: true }
        : { ok: false, error: `TrueNAS rejected the API key (HTTP ${res.status})` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "TrueNAS unreachable" };
    }
  }
  return { ok: true };
}
