import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { synologyListShares, truenasListShares, type NasShare } from "@/lib/nas/discovery";
import { isNasCertificateError } from "@/lib/nas/pinned-fetch";
import { getResolvedNasProvider, resolveNasCredentials, resolveNasProviders, type ResolvedNasProvider } from "@/lib/nas/providers";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";

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

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "nas:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
      shares: perProvider.flat(),
      ...(certificateIssues.length ? { certificateIssues } : {}),
    });
  }

  const provider = await getResolvedNasProvider(providerId);
  if (!provider) return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  try {
    return NextResponse.json({ shares: await listSharesForProvider(provider) });
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
