/**
 * Public contract for the reusable "Authentik SSO in front of any site"
 * capability. Nothing here is WordPress-specific: any consumer (addons, external
 * routes) can place an Authentik edge gate and/or an OIDC client in front of a
 * host with no manual Authentik clicks.
 */

/**
 * - `gate` — Authentik Proxy Provider (forward/transparent auth) registered on the
 *   embedded outpost. The caller still attaches the Traefik `forward-auth`
 *   middleware to the route; this guarantees the host resolves on the outpost so
 *   forward-auth does not 404.
 * - `oidc` — an OAuth2/OpenID provider + Application; returns client credentials
 *   and endpoints the app configures itself (e.g. WordPress auto-login).
 * - `both` — edge gate + OIDC, sharing one Application.
 */
export type GateMode = "gate" | "oidc" | "both";

/** A pluggable secret persistence so the module never hardcodes a vault layout. */
export interface SecretStore {
  read(path: string): Promise<Record<string, string> | null>;
  write(path: string, data: Record<string, string>): Promise<void>;
}

export interface SsoGateInput {
  /** Exact public host, e.g. `blog.example.com` (no scheme). */
  host: string;
  /** Stable application + provider slug, unique per consumer (e.g. `wordpress-blog`). */
  appSlug: string;
  /** Human-readable application name shown in Authentik. */
  appName: string;
  mode: GateMode;
  /** Exact OIDC redirect URIs (no wildcards). Required for `oidc`/`both`. */
  redirectUris?: string[];
  /** Application launch URL shown in the Authentik dashboard. */
  launchUrl?: string;
  /**
   * Vault path where the OIDC client secret is read/minted. Caller-supplied so the
   * module imposes no layout. Required for `oidc`/`both`.
   */
  secretPath?: string;
  /** Public Authentik base URL for the returned issuer/endpoints; falls back to env. */
  issuerBase?: string;
}

export interface OidcCredentials {
  issuer: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  endSessionUrl: string;
  /** JWKS endpoint for ID-token signature verification (no insecure fallback). */
  jwksUrl: string;
}

export interface SsoGateResult {
  oidc?: OidcCredentials;
  /** True when the host is registered as a proxy provider on the embedded outpost. */
  gated: boolean;
}
