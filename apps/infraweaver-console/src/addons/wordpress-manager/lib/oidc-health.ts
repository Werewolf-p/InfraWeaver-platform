/**
 * Pure judgement of whether a WordPress site's OpenID Connect plugin is actually
 * configured, from the raw `openid_connect_generic_settings` option JSON.
 *
 * The exact failure the hi2 login hit: the option is ABSENT (so `wp option get`
 * errors and stdout is empty) or present with an empty `client_id` / `endpoint_login`,
 * which makes the plugin emit an authorize URL with `client_id=`/`scope=` empty and
 * fall back to wp-login.php — a dead login. No server deps so it is trivially tested.
 */

/** Machine tokens for why OIDC is unhealthy. */
export type OidcHealthReason =
  | "settings-missing"
  | "settings-unparseable"
  | "client-id-empty"
  | "endpoint-login-empty";

export interface OidcHealth {
  readonly ok: boolean;
  /** Empty when healthy; otherwise one of OidcHealthReason. */
  readonly reason: "" | OidcHealthReason;
}

export function isOidcHealthy(rawSettings: string): OidcHealth {
  const trimmed = (rawSettings ?? "").trim();
  if (!trimmed) return { ok: false, reason: "settings-missing" };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "settings-unparseable" };
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, reason: "settings-missing" };
  const clientId = typeof obj.client_id === "string" ? obj.client_id.trim() : "";
  const endpointLogin = typeof obj.endpoint_login === "string" ? obj.endpoint_login.trim() : "";
  if (!clientId) return { ok: false, reason: "client-id-empty" };
  if (!endpointLogin) return { ok: false, reason: "endpoint-login-empty" };
  return { ok: true, reason: "" };
}
