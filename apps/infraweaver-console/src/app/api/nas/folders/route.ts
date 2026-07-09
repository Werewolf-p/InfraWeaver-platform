import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { synologyListFolders, truenasListFolders } from "@/lib/nas/discovery";
import { isNasCertificateError } from "@/lib/nas/pinned-fetch";
import { getResolvedNasProvider, resolveNasCredentials } from "@/lib/nas/providers";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "nas:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("nas-folders", req), 30, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const providerId = req.nextUrl.searchParams.get("provider");
  const share = req.nextUrl.searchParams.get("share");
  if (!providerId || !share) return NextResponse.json({ error: "provider and share params required" }, { status: 400 });

  const provider = await getResolvedNasProvider(providerId);
  if (!provider) return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  const creds = await resolveNasCredentials(providerId);
  if (!creds) return NextResponse.json({ folders: [] });

  // A certificate problem is operator-actionable, so it becomes a 409 rather
  // than an empty folder list (or an uncaught 500).
  try {
    if (provider.kind === "synology") {
      const folders = await synologyListFolders(
        {
          host: provider.host,
          port: provider.port,
          tlsFingerprint256: provider.tlsFingerprint256,
          user: creds.username ?? "",
          password: creds.password ?? "",
        },
        share,
      );
      return NextResponse.json({ folders });
    }
    if (provider.kind === "truenas") {
      const folders = await truenasListFolders(
        {
          host: provider.host,
          port: provider.port,
          tlsFingerprint256: provider.tlsFingerprint256,
          apiKey: creds.apiKey ?? "",
        },
        share,
      );
      return NextResponse.json({ folders });
    }
  } catch (error) {
    if (isNasCertificateError(error)) {
      return NextResponse.json(
        { error: error.message, needsCertificateTrust: true, provider: provider.id },
        { status: 409 },
      );
    }
    throw error;
  }
  return NextResponse.json({ folders: [] });
}
