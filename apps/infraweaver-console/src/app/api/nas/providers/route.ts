import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { fetchInternalService } from "@/lib/insecure-fetch";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";

async function checkReachable(url: string): Promise<boolean> {
  try {
    const res = await fetchInternalService(url, { signal: AbortSignal.timeout(2000) }, { allowInsecureTls: true });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "nas:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("nas-providers", req), 30, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const synoHost = process.env.SYNOLOGY_HOST ?? "10.25.0.21";
  const synoPort = process.env.SYNOLOGY_PORT ?? "5001";
  const truenasHost = process.env.TRUENAS_HOST ?? "10.25.0.135";

  const [synoReachable, truenasReachable] = await Promise.all([
    checkReachable(`https://${synoHost}:${synoPort}/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query`),
    checkReachable(`https://${truenasHost}/api/v2/system/info`),
  ]);

  return NextResponse.json({
    providers: [
      { id: "synology", name: "Synology NAS", host: synoHost, port: parseInt(synoPort, 10), protocol: "https", enabled: true, reachable: synoReachable },
      { id: "truenas", name: "TrueNAS Scale", host: truenasHost, port: 443, protocol: "https", enabled: !!process.env.TRUENAS_API_KEY, reachable: truenasReachable },
    ],
  });
}
