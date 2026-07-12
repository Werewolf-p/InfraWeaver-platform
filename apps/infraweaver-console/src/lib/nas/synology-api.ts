/**
 * Thin Synology DSM Web API client — SERVER ONLY.
 *
 * Shared by discovery, credential probing and service-account provisioning so
 * the DSM query-string conventions are handled in exactly one place:
 *
 *   - Every call is `GET /webapi/{auth.cgi|entry.cgi}?api=…&version=…&method=…`,
 *     with `SYNO.API.Auth` served from `auth.cgi` and everything else from
 *     `entry.cgi`.
 *   - Responses are `{ success: boolean, data?: …, error?: { code } }`; DSM
 *     reports failures in-band, never via HTTP status.
 *
 * Every request goes through `fetchNasService`, so the SSRF allowlist and the
 * operator-confirmed TLS certificate pin apply. Query strings carry
 * credentials (`passwd`, `password`, `_sid`) — never log a request URL.
 */

import { fetchNasService } from "@/lib/nas/pinned-fetch";

/** Connection details for a DSM appliance. `tlsFingerprint256` is the pin the
 *  operator confirmed; without it an HTTPS call fails closed. */
export interface SynologyApiConn {
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

/** A connection plus the DSM account used to establish a session. */
export interface SynologyConn extends SynologyApiConn {
  user: string;
  password: string;
}

const DEFAULT_TIMEOUT_MS = 8000;

/** Build a {@link SynologyConn} from a probe/provision target and stored-shape credentials. */
export function toSynologyConn(
  target: { host: string; port: number; tlsFingerprint256?: string; wizardHost?: string },
  creds: { username?: string; password?: string },
): SynologyConn {
  return {
    host: target.host,
    port: target.port,
    tlsFingerprint256: target.tlsFingerprint256,
    wizardHost: target.wizardHost,
    user: creds.username ?? "",
    password: creds.password ?? "",
  };
}

/**
 * Issue one DSM Web API call and return the parsed JSON body. `params` holds
 * `version` (default `"1"`) plus the method's arguments; values are
 * URL-encoded here. Throws on transport, TLS-pin and malformed-body errors —
 * the caller decides how a `success: false` payload degrades.
 */
export async function synoRequest<T>(
  conn: SynologyApiConn,
  api: string,
  method: string,
  params: Record<string, string>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const { version = "1", ...rest } = params;
  const query = Object.entries({ api, version, method, ...rest })
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  const cgi = api === "SYNO.API.Auth" ? "auth.cgi" : "entry.cgi";
  const res = await fetchNasService(
    `https://${conn.host}:${conn.port}/webapi/${cgi}?${query}`,
    { timeoutMs },
    { pin: conn.tlsFingerprint256, wizardHost: conn.wizardHost },
  );
  return (await res.json()) as T;
}

/** A shared folder as reported by `SYNO.FileStation.List` `list_share`. */
export interface SynoShare {
  name: string;
  desc?: string;
  additional?: { real_path?: string };
}

/**
 * List the shared folders visible to the session `sid`. Degrades to `[]` on a
 * `success: false` DSM response; transport/TLS errors propagate (see
 * {@link synoRequest}).
 */
export async function synoListShares(
  conn: SynologyApiConn,
  sid: string,
  timeoutMs?: number,
): Promise<SynoShare[]> {
  const data = await synoRequest<{ success: boolean; data?: { shares?: SynoShare[] } }>(
    conn,
    "SYNO.FileStation.List",
    "list_share",
    { version: "2", SID: sid },
    timeoutMs,
  );
  if (!data.success) return [];
  return data.data?.shares ?? [];
}
