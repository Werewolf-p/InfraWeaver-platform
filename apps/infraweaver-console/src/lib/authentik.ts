import { createServiceFetch } from "@/lib/service-fetch";

const AUTHENTIK_URL = process.env.AUTHENTIK_URL || "http://authentik-server.authentik.svc.cluster.local";
const AUTHENTIK_TOKEN = process.env.AUTHENTIK_TOKEN || "";
const AUTHENTIK_TIMEOUT_MS = 8000;
const AUTHENTIK_SESSION_IDENTIFIER_RE = /^[A-Za-z0-9._:-]{1,160}$/;

export interface AuthentikSessionSummary {
  identifier: string;
  created: string;
  expires?: string;
  description?: string;
}

function sanitizeString(value: unknown, maxLength: number) {
  if (typeof value !== "string") return undefined;
  const sanitized = value.replace(/[\u0000-\u001F\u007F]+/g, " ").trim();
  return sanitized ? sanitized.slice(0, maxLength) : undefined;
}

export function isValidAuthentikIdentifier(value: string) {
  return AUTHENTIK_SESSION_IDENTIFIER_RE.test(value);
}

export function mapAuthentikSessions(results: unknown[]): AuthentikSessionSummary[] {
  return results.flatMap((entry) => {
    const record = entry as {
      identifier?: unknown;
      created?: unknown;
      expires?: unknown;
      description?: unknown;
    };
    const identifier = sanitizeString(record.identifier, 160);
    if (!identifier || !isValidAuthentikIdentifier(identifier)) return [];

    return [{
      identifier,
      created: sanitizeString(record.created, 64) ?? "",
      expires: sanitizeString(record.expires, 64),
      description: sanitizeString(record.description, 256),
    }];
  });
}

const authentikServiceFetch = createServiceFetch({
  baseUrl: `${AUTHENTIK_URL}/api/v3`,
  headers: {
    Authorization: `Bearer ${AUTHENTIK_TOKEN}`,
    "Content-Type": "application/json",
  },
  timeoutMs: AUTHENTIK_TIMEOUT_MS,
});

export async function authentikFetch(path: string, options?: RequestInit) {
  return authentikServiceFetch(path, { ...options, redirect: "error" });
}

async function findUserBy(field: "username" | "email", value: string) {
  const r = await authentikFetch(`/core/users/?${field}=${encodeURIComponent(value)}`);
  if (!r.ok) return null;
  const d = await r.json();
  return d.results?.[0] ?? null;
}

export const findUserByUsername = (username: string) => findUserBy("username", username);

export const findUserByEmail = (email: string) => findUserBy("email", email);
