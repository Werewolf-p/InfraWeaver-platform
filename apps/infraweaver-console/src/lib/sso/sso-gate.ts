/**
 * `ensureSsoGate` / `removeSsoGate` — the one reusable capability that places
 * Authentik SSO in front of any host with no manual Authentik steps. Idempotent
 * and consumer-agnostic: WordPress, external routes and future addons all call it.
 */
import { randomBytes } from "node:crypto";
import { AuthentikClient, type RedirectUri } from "./authentik-client";
import { SsoConfigError } from "./errors";
import type { OidcCredentials, SecretStore, SsoGateInput, SsoGateResult } from "./types";

// Flows/cert resolved by slug/name at runtime so the module is portable across
// Authentik instances (pks differ per install).
const AUTHORIZATION_FLOW_SLUG = "default-provider-authorization-implicit-consent";
const INVALIDATION_FLOW_SLUG = "default-provider-invalidation-flow";
const SIGNING_CERT_NAME = "authentik Self-signed Certificate";
const OIDC_SCOPES = ["openid", "email", "profile"] as const;
const PROXY_SCOPES = ["ak_proxy", "openid", "email", "profile"] as const;

/** A 48-char URL-safe client secret from the CSPRNG. */
function mintClientSecret(): string {
  return randomBytes(36).toString("base64url");
}

function publicIssuerBase(input: SsoGateInput): string {
  const base = (input.issuerBase || process.env.AUTHENTIK_PUBLIC_URL || process.env.AUTHENTIK_ISSUER_BASE || process.env.AUTHENTIK_ISSUER || "").trim();
  if (!base) throw new SsoConfigError("No public Authentik issuer configured (AUTHENTIK_PUBLIC_URL)");
  return base.replace(/\/+$/, "");
}

function oidcCredentials(base: string, appSlug: string, clientId: string, clientSecret: string): OidcCredentials {
  const o = `${base}/application/o`;
  return {
    issuer: `${o}/${appSlug}/`,
    clientId,
    clientSecret,
    authorizeUrl: `${o}/authorize/`,
    tokenUrl: `${o}/token/`,
    userinfoUrl: `${o}/userinfo/`,
    endSessionUrl: `${o}/${appSlug}/end-session/`,
  };
}

/** Read the existing client secret from the store, or mint+persist one. Never rotates. */
async function readOrMintSecret(store: SecretStore, path: string, clientId: string, issuer: string): Promise<string> {
  const existing = await store.read(path);
  if (existing?.clientSecret) return existing.clientSecret;
  const clientSecret = mintClientSecret();
  await store.write(path, { clientId, clientSecret, issuer });
  return clientSecret;
}

function toRedirectUris(urls: string[]): RedirectUri[] {
  return urls.map((url) => ({ matching_mode: "strict", url, redirect_uri_type: "authorization" }));
}

/**
 * Ensure Authentik SSO for `input.host`. Idempotent: providers matched by name,
 * application by slug, outpost membership by pk-set union. Returns OIDC creds when
 * the mode includes `oidc`; the client secret is minted once and never rotated.
 */
export async function ensureSsoGate(input: SsoGateInput, secretStore: SecretStore): Promise<SsoGateResult> {
  const { host, appSlug, appName, mode } = input;
  if (!host || !appSlug) throw new SsoConfigError("host and appSlug are required");
  const wantOidc = mode === "oidc" || mode === "both";
  const wantGate = mode === "gate" || mode === "both";

  const client = AuthentikClient.fromEnv();
  const [authorizationFlow, invalidationFlow] = await Promise.all([
    client.flowPk(AUTHORIZATION_FLOW_SLUG),
    client.flowPk(INVALIDATION_FLOW_SLUG),
  ]);

  let oidc: OidcCredentials | undefined;
  let oauthProviderPk: number | undefined;
  if (wantOidc) {
    if (!input.secretPath) throw new SsoConfigError("secretPath is required for oidc/both");
    if (!input.redirectUris?.length) throw new SsoConfigError("redirectUris are required for oidc/both");
    const issuerBase = publicIssuerBase(input);
    const clientId = appSlug;
    const clientSecret = await readOrMintSecret(secretStore, input.secretPath, clientId, issuerBase);
    const signingKey = await client.signingKeyPk(SIGNING_CERT_NAME);
    oauthProviderPk = await client.upsertProvider("oauth2", appSlug, {
      client_type: "confidential",
      client_id: clientId,
      client_secret: clientSecret,
      authorization_flow: authorizationFlow,
      invalidation_flow: invalidationFlow,
      redirect_uris: toRedirectUris(input.redirectUris),
      sub_mode: "user_email",
      include_claims_in_id_token: true,
      property_mappings: await client.scopeMappingPks(OIDC_SCOPES),
      ...(signingKey ? { signing_key: signingKey } : {}),
    });
    oidc = oidcCredentials(issuerBase, appSlug, clientId, clientSecret);
  }

  let proxyProviderPk: number | undefined;
  if (wantGate) {
    const proxyName = wantOidc ? `${appSlug}-gate` : appSlug;
    proxyProviderPk = await client.upsertProvider("proxy", proxyName, {
      mode: "forward_single",
      external_host: `https://${host}`,
      authorization_flow: authorizationFlow,
      invalidation_flow: invalidationFlow,
      property_mappings: await client.scopeMappingPks(PROXY_SCOPES),
    });
  }

  const primaryProviderPk = wantOidc ? oauthProviderPk : proxyProviderPk;
  await client.upsertApplication(appSlug, {
    name: appName,
    provider: primaryProviderPk,
    backchannel_providers: wantOidc && wantGate && proxyProviderPk ? [proxyProviderPk] : [],
    ...(input.launchUrl ? { meta_launch_url: input.launchUrl } : {}),
  });

  // Register the proxy provider on the embedded outpost LAST, so forward-auth for
  // this host never 404s once the middleware is on the route.
  if (proxyProviderPk !== undefined) await client.addProviderToOutpost(proxyProviderPk);

  return { oidc, gated: wantGate };
}

/**
 * Tear down everything `ensureSsoGate` created for `appSlug`: de-register the proxy
 * provider from the embedded outpost, then delete the application and both
 * providers so stale hosts don't accumulate. Idempotent.
 */
export async function removeSsoGate(appSlug: string, host?: string): Promise<void> {
  void host; // hosts are matched by stable appSlug; host kept for caller symmetry.
  const client = AuthentikClient.fromEnv();
  const oauth = await client.findProvider("oauth2", appSlug);
  const proxy = (await client.findProvider("proxy", `${appSlug}-gate`)) ?? (await client.findProvider("proxy", appSlug));

  if (proxy) await client.removeProviderFromOutpost(proxy.pk);
  await client.deleteApplication(appSlug);
  if (proxy) await client.deleteProvider("proxy", proxy.pk);
  if (oauth) await client.deleteProvider("oauth2", oauth.pk);
}
