import https from "node:https";
import { parseAllowedInternalUrl } from "@/lib/internal-url-allowlist";

const INSECURE_INTERNAL_AGENT = new https.Agent({
  rejectUnauthorized: false,
});

export async function fetchInternalService(
  rawUrl: string,
  init: RequestInit = {},
  options: { allowInsecureTls?: boolean } = {},
) {
  const url = parseAllowedInternalUrl(rawUrl);
  if (!url) {
    throw new Error("URL not allowed");
  }

  const requestInit = {
    ...init,
    cache: init.cache ?? "no-store",
    signal: init.signal ?? AbortSignal.timeout(8000),
  } as RequestInit & { agent?: https.Agent };

  if (options.allowInsecureTls) {
    requestInit.agent = INSECURE_INTERNAL_AGENT;
  }

  return fetch(url, requestInit);
}
