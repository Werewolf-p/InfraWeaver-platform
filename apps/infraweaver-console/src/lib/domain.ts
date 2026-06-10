// Single source of truth for the platform's public base domain.
//
// The base domain is the one value that differs between every fork/deployment
// of InfraWeaver. It is read from NEXT_PUBLIC_BASE_DOMAIN so the value is
// inlined into BOTH the server and the client bundles by Next.js (only
// NEXT_PUBLIC_* vars are exposed to client code). The legacy server-only
// BASE_DOMAIN var is honoured as a fallback for back-compat with the manifest
// templating helpers that already use it.
//
// The sole exception to "everything is a variable" is the feedback endpoint in
// app/api/feedback/route.ts, which is intentionally hardcoded.
const DEFAULT_BASE_DOMAIN = "example.com";

export const BASE_DOMAIN =
  process.env.NEXT_PUBLIC_BASE_DOMAIN?.trim() ||
  process.env.BASE_DOMAIN?.trim() ||
  DEFAULT_BASE_DOMAIN;

/** Internal (homelab LAN) domain, e.g. `int.example.com`. */
export const INTERNAL_DOMAIN = `int.${BASE_DOMAIN}`;

/** Build a public hostname, e.g. `publicHost("onedev")` → `onedev.example.com`. */
export function publicHost(sub: string): string {
  return `${sub}.${BASE_DOMAIN}`;
}

/** Build an internal hostname, e.g. `internalHost("argocd")` → `argocd.int.example.com`. */
export function internalHost(sub: string): string {
  return `${sub}.${INTERNAL_DOMAIN}`;
}
