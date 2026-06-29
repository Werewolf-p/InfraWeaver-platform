import { AUTHENTIK_PLUGIN_SLUG } from "./plugins";
import { authentikBackchannelHostAlias } from "./config";
import type { OidcCredentials } from "@/lib/sso/types";

/** The exact OIDC callback the WordPress OpenID Connect Generic plugin uses. */
export function redirectUri(host: string): string {
  return `https://${host}/wp-admin/admin-ajax.php?action=openid-connect-authorize`;
}

export const OIDC_SETTINGS_OPTION = "openid_connect_generic_settings";

/** Rewrite an https URL to http (used to keep the backchannel off TLS). */
function toHttp(url: string): string {
  return url.startsWith("https://") ? `http://${url.slice("https://".length)}` : url;
}

/**
 * The settings object the OpenID Connect plugin stores. Built from the endpoints
 * Authentik returned for THIS application (no hand-assembled URLs), and returned as
 * data — not a shell string — so `client_secret` is piped to `wp option update`
 * over stdin and never appears as a process argument or k8s exec audit entry.
 */
export function buildOidcSettings(creds: OidcCredentials): Record<string, string | number> {
  // Airgap backchannel mode: when WORDPRESS_AUTHENTIK_BACKCHANNEL_IP is set, site
  // pods pin the issuer host to Authentik's in-cluster Service IP via a hostAlias
  // (see manifest.ts / config.authentikBackchannelHostAlias). The public issuer host
  // NAT-hairpins through Cloudflare and the Traefik LB is unreachable pod-internally,
  // so the SERVER-SIDE OIDC calls (token/userinfo/jwks) must go straight to
  // authentik-server. Two consequences:
  //
  //  1. Authentik's in-cluster https listener (:9443) presents a self-signed cert.
  //     The OpenID Connect Generic plugin (>=3.11) only honours `no_sslverify` in a
  //     local/dev WP environment, so in production it would still fail cert
  //     verification. We therefore send the backchannel over PLAIN HTTP (:9000) —
  //     no TLS, no cert to verify. The hop is an in-cluster, Cilium-enforced pod →
  //     ClusterIP connection with no external exposure.
  //  2. Authentik derives the token `iss` from the request scheme, so a http token
  //     request yields an `http://…` issuer. The plugin rejects the login with
  //     `invalid-iss` unless the configured `issuer` matches, so we set the issuer
  //     to http too. The browser FRONT-channel (authorize/end-session) stays https.
  //
  // `allow_internal_idp` switches the plugin from wp_safe_remote_* (which blocks
  // private-network targets for SSRF safety) to wp_remote_*, required to reach the
  // private ClusterIP.
  const backchannel = authentikBackchannelHostAlias() !== undefined;
  const issuer = backchannel ? toHttp(creds.issuer) : creds.issuer;
  const tokenUrl = backchannel ? toHttp(creds.tokenUrl) : creds.tokenUrl;
  const userinfoUrl = backchannel ? toHttp(creds.userinfoUrl) : creds.userinfoUrl;
  const jwksUrl = backchannel ? toHttp(creds.jwksUrl) : creds.jwksUrl;

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
    // exact discovery issuer (downgraded to http in backchannel mode) so it matches.
    issuer,
    // Front-channel (browser) endpoints stay on the public https issuer host.
    endpoint_login: creds.authorizeUrl,
    endpoint_end_session: creds.endSessionUrl,
    // Server-side (backchannel) endpoints: http when pinned to the in-cluster IdP.
    endpoint_userinfo: userinfoUrl,
    endpoint_token: tokenUrl,
    // The OIDC plugin verifies the ID-token signature against the IdP's JWKS.
    // Without this it falls back to an insecure method (removed in plugin 3.12.0,
    // after which login fails outright). Point it at Authentik's per-app JWKS.
    endpoint_jwks: jwksUrl,
    identity_key: "email",
    // Reach the in-cluster IdP at its private ClusterIP (bypasses the plugin's
    // SSRF guard). Only enabled alongside the pinned backchannel.
    allow_internal_idp: backchannel ? 1 : 0,
    // Backchannel is plain http (or a normally-reachable valid-cert IdP), so peer
    // verification is never bypassed.
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
