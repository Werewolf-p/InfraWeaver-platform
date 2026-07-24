"use client";

/**
 * Client data layer for the fused Site Security surface. Reads go through the
 * dedicated signed-channel route (`GET /api/wordpress/sites/[site]/security?read=…`)
 * as React Query; writes POST `{ verb, params }` to the same route. Mirrors the
 * media explorer's `use-media` idiom exactly — one route, per-verb query keys, a
 * single POST helper.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type {
  ConsentConfigResponse,
  ConsentSetParams,
  ConsentSetResult,
  ProtectionStatusResponse,
  SecurityHardenParams,
  SecurityHardenResult,
  SecurityScanResult,
  SecurityWriteVerb,
} from "./security-consent";

function securityUrl(site: string): string {
  return `/api/wordpress/sites/${encodeURIComponent(site)}/security`;
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Request failed (${res.status})`;
}

export async function fetchSecurityScan(site: string): Promise<SecurityScanResult> {
  const res = await fetch(`${securityUrl(site)}?read=scan`);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as SecurityScanResult;
}

export async function fetchProtectionStatus(site: string): Promise<ProtectionStatusResponse> {
  const res = await fetch(`${securityUrl(site)}?read=status`);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as ProtectionStatusResponse;
}

export async function fetchConsentConfig(site: string): Promise<ConsentConfigResponse> {
  const res = await fetch(`${securityUrl(site)}?read=consent`);
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as ConsentConfigResponse;
}

/** POST a security write verb; throws with the server's message on failure. */
async function postSecurityWrite<T>(site: string, verb: SecurityWriteVerb, params: unknown): Promise<T> {
  const res = await fetch(securityUrl(site), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ verb, params }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as T;
}

/** Apply an allow-listed, closed-enum hardening config (or revert). */
export function applyHardening(site: string, params: SecurityHardenParams): Promise<SecurityHardenResult> {
  return postSecurityWrite<SecurityHardenResult>(site, "harden", params);
}

/** Persist consent settings through the plugin's sanitize gauntlet. */
export function saveConsent(site: string, params: ConsentSetParams): Promise<ConsentSetResult> {
  return postSecurityWrite<ConsentSetResult>(site, "consent", params);
}

// ── query keys (co-located so panels dedupe + invalidate consistently) ─────────
export const securityKeys = {
  scan: (site: string) => ["wordpress-security-scan", site] as const,
  status: (site: string) => ["wordpress-security-status", site] as const,
  consent: (site: string) => ["wordpress-security-consent", site] as const,
};

/** The scan is a live loopback fetch — keep it fresh but not chatty. */
export function useSecurityScan(site: string, enabled = true): UseQueryResult<SecurityScanResult, Error> {
  return useQuery({
    queryKey: securityKeys.scan(site),
    queryFn: () => fetchSecurityScan(site),
    staleTime: 30_000,
    enabled,
  });
}

export function useProtectionStatus(site: string, enabled = true): UseQueryResult<ProtectionStatusResponse, Error> {
  return useQuery({
    queryKey: securityKeys.status(site),
    queryFn: () => fetchProtectionStatus(site),
    staleTime: 20_000,
    enabled,
  });
}

export function useConsentConfig(site: string, enabled = true): UseQueryResult<ConsentConfigResponse, Error> {
  return useQuery({
    queryKey: securityKeys.consent(site),
    queryFn: () => fetchConsentConfig(site),
    staleTime: 20_000,
    enabled,
  });
}
