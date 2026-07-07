/**
 * UDM connector configuration + client factory — SERVER ONLY.
 *
 * Reads config from the environment (host + pinned fingerprint as literals, the
 * API key projected from OpenBao via ESO). The connector is optional: if any
 * required var is missing the console still boots and `getUdmClient()` returns
 * null so callers degrade gracefully (the UDM UI/route reports "not configured"
 * rather than crashing).
 */

import { UdmClient } from "@/lib/udm/client";
import { createHttpsTransport } from "@/lib/udm/https-transport";
import { readStoredUdmConfig } from "@/lib/udm/store";
import type { UdmConfig } from "@/lib/udm/types";

export class UdmConfigError extends Error {}

/**
 * Parse a {@link UdmConfig} from the given env map. Throws {@link UdmConfigError}
 * with a precise message when a required value is absent — never returns a
 * partially-formed config.
 */
export function parseUdmConfig(env: NodeJS.ProcessEnv = process.env): UdmConfig {
  const host = env.UDM_HOST?.trim();
  const apiKey = env.UDM_API_KEY?.trim();
  const fingerprintSha256 = env.UDM_CERT_SHA256?.trim();

  const missing = [
    ["UDM_HOST", host],
    ["UDM_API_KEY", apiKey],
    ["UDM_CERT_SHA256", fingerprintSha256],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new UdmConfigError(`UDM connector not configured: missing ${missing.join(", ")}`);
  }

  return {
    host: host as string,
    apiKey: apiKey as string,
    fingerprintSha256: fingerprintSha256 as string,
    site: env.UDM_SITE?.trim() || "default",
  };
}

/** True when all required UDM env vars are present. */
export function isUdmConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.UDM_HOST?.trim() && env.UDM_API_KEY?.trim() && env.UDM_CERT_SHA256?.trim());
}

/**
 * Build a cert-pinned {@link UdmClient} from the environment, or null when the
 * connector is not configured.
 */
export function getUdmClient(env: NodeJS.ProcessEnv = process.env): UdmClient | null {
  if (!isUdmConfigured(env)) return null;
  const config = parseUdmConfig(env);
  return new UdmClient(createHttpsTransport(config), config.site);
}

/**
 * Build a cert-pinned client from an explicit config — used to test a candidate
 * connector config against the live gateway before persisting it.
 */
export function buildUdmClient(config: UdmConfig): UdmClient {
  return new UdmClient(createHttpsTransport(config), config.site);
}

/**
 * Build a client from the stored (OpenBao) connector config, falling back to the
 * environment. Async because the stored config is read from OpenBao at request
 * time, so a key/host saved through the settings UI is live without a pod
 * restart. Returns null when neither source is configured.
 */
export async function getUdmClientAsync(): Promise<UdmClient | null> {
  const stored = await readStoredUdmConfig().catch(() => null);
  if (stored) return buildUdmClient(stored);
  if (isUdmConfigured()) return buildUdmClient(parseUdmConfig());
  return null;
}
