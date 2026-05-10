const AUTHENTIK_URL = process.env.AUTHENTIK_URL || "http://authentik-server.authentik.svc.cluster.local";
const AUTHENTIK_TOKEN = process.env.AUTHENTIK_TOKEN || "";

export async function authentikFetch(path: string, options?: RequestInit) {
  return fetch(`${AUTHENTIK_URL}/api/v3${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${AUTHENTIK_TOKEN}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
}

export async function findUserByUsername(username: string) {
  const r = await authentikFetch(`/core/users/?username=${encodeURIComponent(username)}`);
  const d = await r.json();
  return d.results?.[0] ?? null;
}

export async function findUserByEmail(email: string) {
  const r = await authentikFetch(`/core/users/?email=${encodeURIComponent(email)}`);
  const d = await r.json();
  return d.results?.[0] ?? null;
}
