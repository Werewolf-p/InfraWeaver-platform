import https from "node:https";

const insecureAgent = new https.Agent({
  rejectUnauthorized: false,
});

export async function fetchInsecure(url: string, init: RequestInit = {}) {
  return fetch(url, {
    ...init,
    cache: init?.cache ?? "no-store",
    signal: init?.signal ?? AbortSignal.timeout(8000),
    agent: insecureAgent,
  } as RequestInit & { agent: https.Agent });
}
