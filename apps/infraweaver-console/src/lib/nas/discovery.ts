/**
 * NAS discovery + credential-probe adapters — SERVER ONLY.
 *
 * Extracted from the `shares`/`folders` route handlers so both built-in (env)
 * and dynamically-added (OpenBao) providers share one code path, and so the
 * "save & test" flow in the providers route can validate credentials against a
 * live NAS before persisting them.
 *
 * Every outbound call goes through `fetchNasService`, which pins requests to
 * the SSRF allowlist AND to the appliance's operator-confirmed TLS certificate
 * fingerprint. The host is taken from a resolved provider config, except on the
 * wizard's save-and-test path, where it is the not-yet-stored host the wizard
 * cleared with `isAllowedInternalHostForWizard` and passed as `wizardHost`.
 *
 * Error contract for the `*List*` adapters: an ordinary failure (bad password,
 * appliance error, malformed body) degrades to `[]`, but a TLS certificate
 * problem THROWS a `NasCertificate*Error`. A cert problem is operator-
 * actionable — silently returning "no shares" would hide the one condition
 * that means "someone may be intercepting this connection". Callers must catch
 * it; `@/app/api/nas/{shares,folders}` turn it into a 409 challenge.
 */

import {
  fetchNasService,
  isNasCertificateError,
  type NasPeerCertificate,
} from "@/lib/nas/pinned-fetch";
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

/** Connection details shared by every adapter. `tlsFingerprint256` is the pin
 *  the operator confirmed; without it an HTTPS call fails closed. */
interface NasConn {
  host: string;
  port: number;
  tlsFingerprint256?: string;
  /**
   * Set to `host` by the wizard only, once `isAllowedInternalHostForWizard` has
   * cleared it, so the save-and-test probe can reach an appliance that is not on
   * the SSRF allowlist yet (it joins the allowlist only once stored). Adapters
   * driven from a resolved provider leave this unset.
   */
  wizardHost?: string;
}

export interface SynologyConn extends NasConn {
  user: string;
  password: string;
}

export interface TruenasConn extends NasConn {
  apiKey: string;
}

const PROBE_TIMEOUT_MS = 5000;

/** TrueNAS serves its REST API under `/api/v2.0` — `/api/v2` is a 404. */
function truenasBase(conn: NasConn): string {
  return `https://${conn.host}:${conn.port}/api/v2.0`;
}

export async function synologyLogin(conn: SynologyConn): Promise<string | null> {
  const user = encodeURIComponent(conn.user);
  const pass = encodeURIComponent(conn.password);
  if (!conn.user || !conn.password) return null;
  try {
    const res = await fetchNasService(
      `https://${conn.host}:${conn.port}/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=login&account=${user}&passwd=${pass}&session=FileStation&format=sid`,
      { timeoutMs: PROBE_TIMEOUT_MS },
      { pin: conn.tlsFingerprint256, wizardHost: conn.wizardHost },
    );
    const data = (await res.json()) as { success: boolean; data?: { sid: string } };
    return data.success ? data.data?.sid ?? null : null;
  } catch (error) {
    // A cert problem is an operator-actionable configuration state, not a
    // "wrong password" — let it reach the caller instead of becoming `null`.
    if (isNasCertificateError(error)) throw error;
    return null;
  }
}

export async function synologyListShares(conn: SynologyConn): Promise<NasShare[]> {
  const sid = await synologyLogin(conn);
  if (!sid) return [];
  try {
    const res = await fetchNasService(
      `https://${conn.host}:${conn.port}/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list_share&SID=${sid}`,
      { timeoutMs: PROBE_TIMEOUT_MS },
      { pin: conn.tlsFingerprint256, wizardHost: conn.wizardHost },
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
  } catch (error) {
    if (isNasCertificateError(error)) throw error;
    return [];
  }
}

export async function synologyListFolders(conn: SynologyConn, share: string): Promise<NasFolder[]> {
  const sid = await synologyLogin(conn);
  if (!sid) return [];
  try {
    const folderPath = encodeURIComponent(`/${share}`);
    const res = await fetchNasService(
      `https://${conn.host}:${conn.port}/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list&folder_path=${folderPath}&filetype=dir&SID=${sid}`,
      { timeoutMs: PROBE_TIMEOUT_MS },
      { pin: conn.tlsFingerprint256, wizardHost: conn.wizardHost },
    );
    const data = (await res.json()) as { success: boolean; data?: { files: Array<{ name: string; path: string }> } };
    if (!data.success) return [];
    return (data.data?.files ?? []).map((file) => ({ name: file.name, path: file.path }));
  } catch (error) {
    if (isNasCertificateError(error)) throw error;
    return [];
  }
}

export async function truenasListShares(conn: TruenasConn): Promise<NasShare[]> {
  if (!conn.apiKey) return [];
  try {
    const res = await fetchNasService(
      `${truenasBase(conn)}/sharing/smb`,
      { headers: { Authorization: `Bearer ${conn.apiKey}` }, timeoutMs: PROBE_TIMEOUT_MS },
      { pin: conn.tlsFingerprint256, wizardHost: conn.wizardHost },
    );
    if (!res.ok) return [];
    const shares = await res.json();
    if (!Array.isArray(shares)) return [];
    return (shares as Array<{ name: string; path: string }>).map((share) => ({ name: share.name, path: share.path }));
  } catch (error) {
    if (isNasCertificateError(error)) throw error;
    return [];
  }
}

export async function truenasListFolders(conn: TruenasConn, share: string): Promise<NasFolder[]> {
  if (!conn.apiKey) return [];
  try {
    const res = await fetchNasService(
      `${truenasBase(conn)}/pool/dataset?type=FILESYSTEM&limit=50`,
      { headers: { Authorization: `Bearer ${conn.apiKey}` }, timeoutMs: PROBE_TIMEOUT_MS },
      { pin: conn.tlsFingerprint256, wizardHost: conn.wizardHost },
    );
    if (!res.ok) return [];
    const parsed = await res.json();
    if (!Array.isArray(parsed)) return [];
    const datasets = parsed as Array<{ name: string; mountpoint?: { value?: string } }>;
    return datasets
      .filter((dataset) => dataset.name.toLowerCase().includes(share.toLowerCase()))
      .map((dataset) => ({
        name: dataset.name.split("/").pop() ?? dataset.name,
        path: dataset.mountpoint?.value ?? `/${dataset.name}`,
      }));
  } catch (error) {
    if (isNasCertificateError(error)) throw error;
    return [];
  }
}

export interface ProbeTarget {
  host: string;
  port: number;
  kind: "synology" | "truenas" | "generic-smb" | "generic-nfs";
  tlsFingerprint256?: string;
  /** See `NasConn.wizardHost` — set only by the wizard's save-and-test probe. */
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
      const sid = await synologyLogin({
        host: target.host,
        port: target.port,
        tlsFingerprint256: target.tlsFingerprint256,
        wizardHost: target.wizardHost,
        user: credentials.username,
        password: credentials.password,
      });
      return sid ? { ok: true } : { ok: false, error: "Synology login failed — check host and credentials" };
    } catch (error) {
      return certificateFailure(error) ?? { ok: false, error: "Synology unreachable" };
    }
  }
  if (target.kind === "truenas") {
    if (!credentials.apiKey) return { ok: false, error: "API key is required" };
    try {
      const res = await fetchNasService(
        `${truenasBase(target)}/system/info`,
        { headers: { Authorization: `Bearer ${credentials.apiKey}` }, timeoutMs: PROBE_TIMEOUT_MS },
        { pin: target.tlsFingerprint256, wizardHost: target.wizardHost },
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
