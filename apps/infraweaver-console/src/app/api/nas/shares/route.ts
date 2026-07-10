import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { synologyListShares, truenasListShares, type NasShare } from "@/lib/nas/discovery";
import { isNasCertificateError } from "@/lib/nas/pinned-fetch";
import { getResolvedNasProvider, resolveNasCredentials, resolveNasProviders, type ResolvedNasProvider } from "@/lib/nas/providers";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, type SessionRBACContext } from "@/lib/session-rbac";
import { canAccessNasFolder, canReadStorage } from "@/lib/nas/authz";

/**
 * A provider whose TLS certificate is untrusted or has changed. Surfaced to the
 * operator rather than silently rendering as "no shares".
 */
interface CertificateIssue {
  provider: string;
  state: "untrusted" | "mismatch";
  message: string;
}

/** Enumerate shares for one resolved provider using its stored/env credentials. */
async function listSharesForProvider(provider: ResolvedNasProvider): Promise<Array<NasShare & { provider: string }>> {
  const creds = await resolveNasCredentials(provider.id);
  if (!creds) return [];
  let shares: NasShare[] = [];
  if (provider.kind === "synology") {
    shares = await synologyListShares({
      host: provider.host,
      port: provider.port,
      tlsFingerprint256: provider.tlsFingerprint256,
      user: creds.username ?? "",
      password: creds.password ?? "",
    });
  } else if (provider.kind === "truenas") {
    shares = await truenasListShares({
      host: provider.host,
      port: provider.port,
      tlsFingerprint256: provider.tlsFingerprint256,
      apiKey: creds.apiKey ?? "",
    });
  }
  return shares.map((share) => ({ ...share, provider: provider.id }));
}

type ListedShare = NasShare & { provider: string };

/**
 * Hide the shares the caller may not read, and tag the survivors with the access
 * they actually hold so the UI can badge them without a second round trip.
 * Enumeration is disclosure: a user granted one folder must not learn the names
 * of the finance share next to it.
 *
 * Each entry carries its own provider — the unfiltered listing fans out across
 * every appliance — so the scope is rebuilt per share rather than per batch.
 */
function scopeSharesToCaller(rbac: SessionRBACContext, shares: ListedShare[]) {
  return shares
    .filter((share) =>
      canAccessNasFolder(rbac, { provider: share.provider, share: share.name, subfolder: "", access: "readonly" }),
    )
    .map((share) => ({
      ...share,
      access: canAccessNasFolder(rbac, { provider: share.provider, share: share.name, subfolder: "", access: "readwrite" })
        ? ("readwrite" as const)
        : ("readonly" as const),
    }));
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  // Admission is coarse — "does the caller hold nas:read anywhere under /nas?".
  // Each individual share is then checked against its own scope below, so a user
  // granted exactly one folder gets in the door and sees exactly that folder.
  if (!canReadStorage(access)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("nas-shares", req), 30, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const providerId = req.nextUrl.searchParams.get("provider");
  if (!providerId) {
    // Fan out across every registered provider (built-in + dynamic). One
    // appliance with an untrusted certificate must not blank out the others,
    // so failures are collected per provider instead of rejecting the batch.
    const providers = await resolveNasProviders();
    const certificateIssues: CertificateIssue[] = [];
    const perProvider = await Promise.all(
      providers.map(async (p) => {
        try {
          return await listSharesForProvider(p);
        } catch (error) {
          if (isNasCertificateError(error)) {
            certificateIssues.push({
              provider: p.id,
              state: error.code === "NAS_CERT_MISMATCH" ? "mismatch" : "untrusted",
              message: error.message,
            });
            return [];
          }
          throw error;
        }
      }),
    );
    return NextResponse.json({
      shares: scopeSharesToCaller(access, perProvider.flat()),
      ...(certificateIssues.length ? { certificateIssues } : {}),
    });
  }

  const provider = await getResolvedNasProvider(providerId);
  if (!provider) return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  try {
    return NextResponse.json({ shares: scopeSharesToCaller(access, await listSharesForProvider(provider)) });
  } catch (error) {
    if (isNasCertificateError(error)) {
      return NextResponse.json(
        { error: error.message, needsCertificateTrust: true, provider: provider.id },
        { status: 409 },
      );
    }
    throw error;
  }
}
