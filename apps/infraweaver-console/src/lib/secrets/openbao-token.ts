import "server-only";

/**
 * OpenBao token lifecycle helpers — SERVER ONLY.
 *
 * The static `external-secrets/openbao-token` silently counts down; when it
 * expires, every ExternalSecret goes Ready=False and ArgoCD's Lua health check
 * flips Degraded (see memory: eso-openbao-token-expiry). These helpers surface
 * the countdown (`lookupSelfToken`) and offer the two documented remediations —
 * the low-risk `renewSelfToken` and the gated, high-risk `remintPeriodicToken`.
 *
 * The token value NEVER leaves the server: `remintPeriodicToken` writes the new
 * token straight into the Kubernetes secret and returns only metadata.
 */

import { OPENBAO_REQUEST_TIMEOUT_MS, vaultAuth } from "@/lib/openbao/kv";
import { parseTokenLookupData, type TokenStatus } from "@/lib/secrets/lifecycle-types";

const REMINT_TOKEN_POLICY = process.env.OPENBAO_ESO_TOKEN_POLICY || "platform-k8s";
const REMINT_TOKEN_PERIOD = process.env.OPENBAO_ESO_TOKEN_PERIOD || "8760h";

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(OPENBAO_REQUEST_TIMEOUT_MS);
}

/**
 * Query `/v1/auth/token/lookup-self`. Degrades to `available:false` on any
 * failure (unreachable, non-200, timeout) — NEVER throws, so the collector can
 * fan out with Promise.allSettled and still render every other section.
 */
export async function lookupSelfToken(): Promise<TokenStatus> {
  const unavailable = (error: string): TokenStatus => ({
    available: false,
    ttlSeconds: null,
    expireTime: null,
    renewable: false,
    policies: [],
    error,
  });

  let addr: string;
  let token: string;
  try {
    ({ addr, token } = vaultAuth());
  } catch (err) {
    return unavailable(err instanceof Error ? err.message : "OpenBao not configured");
  }

  try {
    const res = await fetch(`${addr}/v1/auth/token/lookup-self`, {
      method: "GET",
      headers: { "X-Vault-Token": token },
      signal: timeoutSignal(),
    });
    if (!res.ok) return unavailable(`lookup-self failed: ${res.status}`);
    const body = (await res.json()) as unknown;
    return { available: true, ...parseTokenLookupData(body) };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") return unavailable("OpenBao request timed out");
    return unavailable(err instanceof Error ? err.message : "OpenBao unreachable");
  }
}

/**
 * Low-risk remediation: extend the CURRENT token's lease via
 * `/v1/auth/token/renew-self`. Returns the refreshed TTL only. Never throws.
 */
export async function renewSelfToken(): Promise<{ ok: boolean; ttlSeconds: number | null; error?: string }> {
  let addr: string;
  let token: string;
  try {
    ({ addr, token } = vaultAuth());
  } catch (err) {
    return { ok: false, ttlSeconds: null, error: err instanceof Error ? err.message : "OpenBao not configured" };
  }

  try {
    const res = await fetch(`${addr}/v1/auth/token/renew-self`, {
      method: "POST",
      headers: { "X-Vault-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: timeoutSignal(),
    });
    if (!res.ok) return { ok: false, ttlSeconds: null, error: `renew-self failed: ${res.status}` };
    const body = (await res.json()) as { auth?: { lease_duration?: number } };
    const ttl = body.auth?.lease_duration;
    return { ok: true, ttlSeconds: typeof ttl === "number" ? ttl : null };
  } catch (err) {
    return { ok: false, ttlSeconds: null, error: err instanceof Error ? err.message : "OpenBao unreachable" };
  }
}

/**
 * HIGH-RISK remediation (gated by SECRET_REMEDIATION_WRITE_ENABLED at the route):
 * mint a new PERIODIC token (`/v1/auth/token/create`) scoped to the ESO policy,
 * returning ONLY the token value + TTL to the SERVER caller. The route writes the
 * value into the k8s secret and never returns it to the browser.
 */
export async function remintPeriodicToken(): Promise<{
  ok: boolean;
  token?: string;
  ttlSeconds: number | null;
  accessor?: string;
  error?: string;
}> {
  let addr: string;
  let token: string;
  try {
    ({ addr, token } = vaultAuth());
  } catch (err) {
    return { ok: false, ttlSeconds: null, error: err instanceof Error ? err.message : "OpenBao not configured" };
  }

  try {
    const res = await fetch(`${addr}/v1/auth/token/create`, {
      method: "POST",
      headers: { "X-Vault-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ policies: [REMINT_TOKEN_POLICY], period: REMINT_TOKEN_PERIOD, no_default_policy: true }),
      signal: timeoutSignal(),
    });
    if (!res.ok) return { ok: false, ttlSeconds: null, error: `token create failed: ${res.status}` };
    const body = (await res.json()) as {
      auth?: { client_token?: string; lease_duration?: number; accessor?: string };
    };
    const clientToken = body.auth?.client_token;
    if (!clientToken) return { ok: false, ttlSeconds: null, error: "token create returned no token" };
    const ttl = body.auth?.lease_duration;
    return {
      ok: true,
      token: clientToken,
      ttlSeconds: typeof ttl === "number" ? ttl : null,
      accessor: body.auth?.accessor,
    };
  } catch (err) {
    return { ok: false, ttlSeconds: null, error: err instanceof Error ? err.message : "OpenBao unreachable" };
  }
}
