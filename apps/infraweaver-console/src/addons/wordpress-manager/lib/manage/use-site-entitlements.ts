"use client";

/**
 * `useSiteEntitlements(site)` — the ONE client-side source of truth for what a
 * site is entitled to. Reads the existing managed-link payload
 * (`GET /api/wordpress/sites/[site]/iwsl`) and resolves it through the
 * console-authoritative `lib/tiers.ts` helpers. Panels gate on the returned
 * flags; they must NOT fetch the link themselves (the connector view + site
 * detail historically did this ad hoc — those collapse into this hook).
 *
 * SECURITY: the tier + flag map come from the CONSOLE link record only, resolved
 * by `resolveEntitlements`/`resolveTierId`. A WordPress site can never influence
 * what the console believes is granted.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { resolveEntitlements, resolveTierId, type TierId } from "../tiers";
import type { EntitlementFlag, EntitlementMap } from "../entitlements";

/** The minimal slice of the managed-link payload this hook reads. */
interface LinkSlice {
  readonly state?: "pending" | "active" | "quarantined";
  readonly fingerprintConfirmed?: boolean;
  readonly identitySuspended?: boolean;
  readonly tier?: TierId;
  readonly entitlements?: { flags?: EntitlementMap };
  /** Per-site feature kill-switch state, when the connector reports it (absent ⇒ unknown). */
  readonly featureSwitches?: Partial<Record<EntitlementFlag, boolean>>;
}

/** Everything a panel needs to render the triple gate (tier · switch · connector). */
export interface SiteEntitlementsView {
  readonly tier: TierId;
  /** Authoritative boolean flag map, resolved from the console record only. */
  readonly flags: EntitlementMap;
  /** Per-site kill-switch state; empty `{}` until the connector surfaces switches. */
  readonly switches: Partial<Record<EntitlementFlag, boolean>>;
  /** True when the link is active AND fingerprint-confirmed. */
  readonly connectorActive: boolean;
  /** True when state-changing ops are suspended (identity changed on the site). */
  readonly identitySuspended: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  /** Whether the tier GRANTS a flag (ignores switch state). */
  has(flag: EntitlementFlag): boolean;
  /** Whether a granted flag is switched OFF on this site (true only when explicitly off). */
  isSwitchedOff(flag: EntitlementFlag): boolean;
}

/** Shared query key so every panel dedupes the single link read. */
export function siteEntitlementsKey(site: string): readonly [string, string] {
  return ["wordpress-iwsl-link", site];
}

async function fetchLink(site: string): Promise<LinkSlice | null> {
  const res = await fetch(`/api/wordpress/sites/${encodeURIComponent(site)}/iwsl`);
  if (!res.ok) throw new Error("Failed to load site entitlements");
  const body = (await res.json()) as { link?: LinkSlice | null };
  return body.link ?? null;
}

export function useSiteEntitlements(site: string): SiteEntitlementsView {
  const query = useQuery({
    queryKey: siteEntitlementsKey(site),
    queryFn: () => fetchLink(site),
    staleTime: 20_000,
  });

  return useMemo<SiteEntitlementsView>(() => {
    const link = query.data ?? undefined;
    const flags = resolveEntitlements(link);
    const switches = link?.featureSwitches ?? {};
    const has = (flag: EntitlementFlag): boolean => flags[flag] === true;
    return {
      tier: resolveTierId(link),
      flags,
      switches,
      connectorActive: link?.state === "active" && link?.fingerprintConfirmed === true,
      identitySuspended: link?.identitySuspended === true,
      loading: query.isPending,
      error: query.error instanceof Error ? query.error.message : query.error ? "Failed to load" : null,
      has,
      isSwitchedOff: (flag: EntitlementFlag): boolean => has(flag) && switches[flag] === false,
    };
  }, [query.data, query.isPending, query.error]);
}
