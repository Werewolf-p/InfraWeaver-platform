import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { synologyListShares, truenasListShares, type NasShare } from "@/lib/nas/discovery";
import { getResolvedNasProvider, resolveNasCredentials, resolveNasProviders, type ResolvedNasProvider } from "@/lib/nas/providers";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";

/** Enumerate shares for one resolved provider using its stored/env credentials. */
async function listSharesForProvider(provider: ResolvedNasProvider): Promise<Array<NasShare & { provider: string }>> {
  const creds = await resolveNasCredentials(provider.id);
  if (!creds) return [];
  let shares: NasShare[] = [];
  if (provider.kind === "synology") {
    shares = await synologyListShares({
      host: provider.host,
      port: provider.port,
      user: creds.username ?? "",
      password: creds.password ?? "",
    });
  } else if (provider.kind === "truenas") {
    shares = await truenasListShares({ host: provider.host, apiKey: creds.apiKey ?? "" });
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
    // Fan out across every registered provider (built-in + dynamic).
    const providers = await resolveNasProviders();
    const perProvider = await Promise.all(providers.map((p) => listSharesForProvider(p)));
    return NextResponse.json({ shares: perProvider.flat() });
  }

  const provider = await getResolvedNasProvider(providerId);
  if (!provider) return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  return NextResponse.json({ shares: await listSharesForProvider(provider) });
}
