import { parseAllowedInternalUrlAsync } from "@/lib/internal-url-allowlist-server";

/**
 * SECURITY NOTE — `allowInsecureTls` does NOT disable TLS verification.
 *
 * The WHATWG `fetch` provided by undici (Node's global fetch) ignores a Node
 * `https.Agent` passed via `RequestInit.agent`, so there is no supported way to
 * turn off certificate verification here. This flag is therefore a no-op that
 * FAILS SECURE: a request to a service with an untrusted certificate will still
 * reject. It is retained only so callers can express intent without changing
 * behavior. Do NOT "fix" this into a real TLS bypass (e.g. by setting
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` or a custom dispatcher) — that would
 * introduce a MITM vulnerability for every internal call.
 */
export async function fetchInternalService(
  rawUrl: string,
  init: RequestInit = {},
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  options: { allowInsecureTls?: boolean } = {},
) {
  const url = await parseAllowedInternalUrlAsync(rawUrl);
  if (!url) {
    throw new Error("URL not allowed");
  }

  const requestInit: RequestInit = {
    ...init,
    cache: init.cache ?? "no-store",
    signal: init.signal ?? AbortSignal.timeout(8000),
  };

  return fetch(url, requestInit);
}
