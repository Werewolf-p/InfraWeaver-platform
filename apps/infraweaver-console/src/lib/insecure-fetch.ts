import https from "node:https";

export async function fetchInsecure(url: string, init: RequestInit = {}) {
  const agent = new https.Agent({
    rejectUnauthorized: false,
  });

  return fetch(url, {
    ...init,
    cache: init?.cache ?? "no-store",
    signal: init?.signal ?? AbortSignal.timeout(8000),
    agent,
  } as RequestInit & { agent: https.Agent });
}
