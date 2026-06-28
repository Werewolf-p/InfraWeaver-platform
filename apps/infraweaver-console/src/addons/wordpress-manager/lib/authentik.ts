import { AUTHENTIK_PLUGIN_SLUG } from "./plugins";
import type { OidcCredentials } from "@/lib/sso/types";

/** The exact OIDC callback the WordPress OpenID Connect Generic plugin uses. */
export function redirectUri(host: string): string {
  return `https://${host}/wp-admin/admin-ajax.php?action=openid-connect-authorize`;
}

export const OIDC_SETTINGS_OPTION = "openid_connect_generic_settings";

/**
 * The settings object the OpenID Connect plugin stores. Built from the endpoints
 * Authentik returned for THIS application (no hand-assembled URLs), and returned as
 * data — not a shell string — so `client_secret` is piped to `wp option update`
 * over stdin and never appears as a process argument or k8s exec audit entry.
 */
export function buildOidcSettings(creds: OidcCredentials): Record<string, string | number> {
  return {
    login_type: "auto",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope: "openid email profile",
    // Authentik issues the ID token with a per-provider `iss`
    // (`<base>/application/o/<app-slug>/`). Without an explicit issuer the OIDC
    // plugin derives the expected issuer from `endpoint_login` as scheme+host
    // only (`<base>`), so every login fails validation with
    // `invalid-iss: Token issuer does not match expected issuer`. Pin it to the
    // exact discovery issuer so the claim matches.
    issuer: creds.issuer,
    endpoint_login: creds.authorizeUrl,
    endpoint_userinfo: creds.userinfoUrl,
    endpoint_token: creds.tokenUrl,
    endpoint_end_session: creds.endSessionUrl,
    identity_key: "email",
    no_sslverify: 0,
    enforce_privacy: 0,
    link_existing_users: 1,
    create_if_does_not_exist: 1,
    redirect_user_back: 1,
  };
}

/** Install/activate the OIDC plugin (no secret on the command line). */
export function pluginInstallCommand(): string {
  return `wp --allow-root plugin install ${AUTHENTIK_PLUGIN_SLUG} --activate`;
}

/**
 * `wp option update <key> --format=json` with the value OMITTED — wp-cli then reads
 * the JSON value from STDIN, so the client secret never appears as a command
 * argument (and so never in the k8s exec audit log). NOTE: an explicit `-`
 * placeholder does NOT work on wp-cli 2.x — it is parsed as the literal value
 * ("Invalid JSON: -"); the value arg must simply be absent.
 */
export function optionUpdateFromStdinCommand(option: string): string {
  return `wp --allow-root option update ${option} --format=json`;
}
