// Shared guards for the /api/nas/* routes: provider resolution and the TLS
// certificate challenge. Both preserve the exact error bodies the individual
// routes answered with before extraction.

import { NextResponse } from "next/server";
import { isNasCertificateError } from "@/lib/nas/pinned-fetch";
import { getResolvedNasProvider, resolveNasProviders, type ResolvedNasProvider } from "@/lib/nas/providers";

/**
 * Wording of the 400 when a provider id is unknown — each route kept its own:
 *   "short":  { error: "Unknown provider" }
 *   "named":  { error: "Unknown NAS provider '<id>'" }
 *   "listed": "named" + the currently-registered ids appended.
 */
export type UnknownNasProviderStyle = "short" | "named" | "listed";

export type NasProviderResolution =
  | { provider: ResolvedNasProvider; response?: undefined }
  | { provider?: undefined; response: NextResponse };

/**
 * Resolve a provider id via the registry, or produce the route's canonical 400.
 * Returns a discriminated union (not a NextResponse union) so callers can
 * `if (resolved.response) return resolved.response;`.
 */
export async function requireNasProvider(
  providerId: string,
  style: UnknownNasProviderStyle = "short",
): Promise<NasProviderResolution> {
  const provider = await getResolvedNasProvider(providerId);
  if (provider) return { provider };
  if (style === "short") {
    return { response: NextResponse.json({ error: "Unknown provider" }, { status: 400 }) };
  }
  if (style === "named") {
    return { response: NextResponse.json({ error: `Unknown NAS provider '${providerId}'` }, { status: 400 }) };
  }
  const registered = (await resolveNasProviders()).map((p) => p.id).join(", ") || "(none)";
  return {
    response: NextResponse.json(
      { error: `Unknown NAS provider '${providerId}'. Registered: ${registered}` },
      { status: 400 },
    ),
  };
}

/** A certificate problem is operator-actionable: 409, never an empty list. */
export function nasCertificateChallenge(error: unknown, providerId: string): NextResponse | null {
  if (!isNasCertificateError(error)) return null;
  return NextResponse.json(
    { error: error.message, needsCertificateTrust: true, provider: providerId },
    { status: 409 },
  );
}
