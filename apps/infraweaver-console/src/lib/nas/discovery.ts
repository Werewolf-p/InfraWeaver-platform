/**
 * NAS discovery + credential-probe adapters — SERVER ONLY.
 *
 * Extracted from the `shares`/`folders` route handlers so both built-in (env)
 * and dynamically-added (OpenBao) providers share one code path, and so the
 * "save & test" flow in the providers route can validate credentials against a
 * live NAS before persisting them.
 *
 * Every outbound call goes through the `synoRequest`/`truenasRequest` clients,
 * which pin requests to the SSRF allowlist AND to the appliance's
 * operator-confirmed TLS certificate fingerprint. The host is taken from a
 * resolved provider config, except on the wizard's save-and-test path, where it
 * is the not-yet-stored host the wizard cleared with
 * `isAllowedInternalHostForWizard` and passed as `wizardHost`.
 *
 * Error contract for the `*List*` adapters: an ordinary failure (bad password,
 * appliance error, malformed body) degrades to `[]`, but a TLS certificate
 * problem THROWS a `NasCertificate*Error`. A cert problem is operator-
 * actionable — silently returning "no shares" would hide the one condition
 * that means "someone may be intercepting this connection". Callers must catch
 * it; `@/app/api/nas/{shares,folders}` turn it into a 409 challenge.
 */

import { isNasCertificateError, type NasPeerCertificate } from "@/lib/nas/pinned-fetch";
import type { StoredNasCredentials } from "@/lib/nas/store";
import { synoListShares, synoRequest, toSynologyConn, type SynologyConn } from "@/lib/nas/synology-api";
import { truenasRequest, type TruenasConnection } from "@/lib/nas/truenas-api";

export type { SynologyConn };
export type TruenasConn = TruenasConnection;

export interface NasShare {
  name: string;
  desc?: string;
  path: string;
}

export interface NasFolder {
  name: string;
  path: string;
}

const PROBE_TIMEOUT_MS = 5000;

/**
 * Run one NAS call with the adapters' error contract: an ordinary failure
 * degrades to `fallback`, but a `NasCertificate*Error` is rethrown because it
 * is operator-actionable configuration state, not a "wrong password".
 */
async function withNasFallback<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isNasCertificateError(error)) throw error;
    return fallback;
  }
}

export async function synologyLogin(conn: SynologyConn): Promise<string | null> {
  if (!conn.user || !conn.password) return null;
  return withNasFallback<string | null>(null, async () => {
    const data = await synoRequest<{ success: boolean; data?: { sid: string } }>(
      conn,
      "SYNO.API.Auth",
      "login",
      { version: "3", account: conn.user, passwd: conn.password, session: "FileStation", format: "sid" },
      PROBE_TIMEOUT_MS,
    );
    return data.success ? data.data?.sid ?? null : null;
  });
}

export async function synologyListShares(conn: SynologyConn): Promise<NasShare[]> {
  const sid = await synologyLogin(conn);
  if (!sid) return [];
  return withNasFallback<NasShare[]>([], async () => {
    const shares = await synoListShares(conn, sid, PROBE_TIMEOUT_MS);
    return shares.map((share) => ({
      name: share.name,
      desc: share.desc ?? "",
      path: share.additional?.real_path ?? `/${share.name}`,
    }));
  });
}

export async function synologyListFolders(conn: SynologyConn, share: string): Promise<NasFolder[]> {
  const sid = await synologyLogin(conn);
  if (!sid) return [];
  return withNasFallback<NasFolder[]>([], async () => {
    const data = await synoRequest<{ success: boolean; data?: { files: Array<{ name: string; path: string }> } }>(
      conn,
      "SYNO.FileStation.List",
      "list",
      { version: "2", folder_path: `/${share}`, filetype: "dir", SID: sid },
      PROBE_TIMEOUT_MS,
    );
    if (!data.success) return [];
    return (data.data?.files ?? []).map((file) => ({ name: file.name, path: file.path }));
  });
}

export async function truenasListShares(conn: TruenasConn): Promise<NasShare[]> {
  if (!conn.apiKey) return [];
  return withNasFallback<NasShare[]>([], async () => {
    const res = await truenasRequest<Array<{ name: string; path: string }>>(conn, "/sharing/smb", {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (!res.ok || !Array.isArray(res.body)) return [];
    return res.body.map((share) => ({ name: share.name, path: share.path }));
  });
}

export async function truenasListFolders(conn: TruenasConn, share: string): Promise<NasFolder[]> {
  if (!conn.apiKey) return [];
  return withNasFallback<NasFolder[]>([], async () => {
    const res = await truenasRequest<Array<{ name: string; mountpoint?: { value?: string } }>>(
      conn,
      "/pool/dataset?type=FILESYSTEM&limit=50",
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    if (!res.ok || !Array.isArray(res.body)) return [];
    return res.body
      .filter((dataset) => dataset.name.toLowerCase().includes(share.toLowerCase()))
      .map((dataset) => ({
        name: dataset.name.split("/").pop() ?? dataset.name,
        path: dataset.mountpoint?.value ?? `/${dataset.name}`,
      }));
  });
}

export interface ProbeTarget {
  host: string;
  port: number;
  kind: "synology" | "truenas" | "generic-smb" | "generic-nfs";
  tlsFingerprint256?: string;
  /** See `SynologyApiConn.wizardHost` — set only by the wizard's save-and-test probe. */
  wizardHost?: string;
}

export interface ProbeResult {
  ok: boolean;
  error?: string;
  /**
   * Set when the appliance's certificate is untrusted or no longer matches the
   * pin. The caller surfaces it so the operator can confirm the new
   * certificate; the credentials were NOT sent to the peer.
   */
  certificate?: NasPeerCertificate;
  /** `untrusted` = never pinned; `mismatch` = pinned, but the cert changed. */
  certificateState?: "untrusted" | "mismatch";
}

/** Map a certificate failure into a probe result the API layer can render. */
function certificateFailure(error: unknown): ProbeResult | null {
  if (!isNasCertificateError(error)) return null;
  const mismatch = error.code === "NAS_CERT_MISMATCH";
  return {
    ok: false,
    certificate: error.certificate,
    certificateState: mismatch ? "mismatch" : "untrusted",
    error: mismatch
      ? `The TLS certificate for ${error.host} no longer matches the trusted fingerprint.`
      : `The TLS certificate for ${error.host} is not trusted yet.`,
  };
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
): Promise<ProbeResult> {
  if (target.kind === "synology") {
    if (!credentials.username || !credentials.password) {
      return { ok: false, error: "username and password are required" };
    }
    try {
      const sid = await synologyLogin(toSynologyConn(target, credentials));
      return sid ? { ok: true } : { ok: false, error: "Synology login failed — check host and credentials" };
    } catch (error) {
      return certificateFailure(error) ?? { ok: false, error: "Synology unreachable" };
    }
  }
  if (target.kind === "truenas") {
    if (!credentials.apiKey) return { ok: false, error: "API key is required" };
    try {
      const res = await truenasRequest(
        {
          host: target.host,
          port: target.port,
          apiKey: credentials.apiKey,
          tlsFingerprint256: target.tlsFingerprint256,
          wizardHost: target.wizardHost,
        },
        "/system/info",
        { timeoutMs: PROBE_TIMEOUT_MS },
      );
      return res.ok
        ? { ok: true }
        : { ok: false, error: `TrueNAS rejected the API key (HTTP ${res.status})` };
    } catch (error) {
      return (
        certificateFailure(error) ?? {
          ok: false,
          error: error instanceof Error ? error.message : "TrueNAS unreachable",
        }
      );
    }
  }
  return { ok: true };
}
