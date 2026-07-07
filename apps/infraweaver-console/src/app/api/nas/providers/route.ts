// GET /api/nas/providers — enumerate registered NAS providers and probe them.
//
// The provider list comes from `@/lib/nas/providers` so future backends
// (declared via `NAS_PROVIDERS_JSON` or a new built-in in that file) surface
// here — and in every UI/API that fans out from it — with zero changes to
// this route.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { fetchInternalService } from "@/lib/insecure-fetch";
import { isProviderEnabled, listProviderConfigs, type NasProviderConfig } from "@/lib/nas/providers";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";

// Discovery probe URLs per provider kind — extending the enum in
// `NasProviderConfig["kind"]` requires adding an entry here.
function probeUrl(provider: NasProviderConfig): string {
  const base = `${provider.protocol}://${provider.host}:${provider.port}`;
  switch (provider.kind) {
    case "synology":
      return `${base}/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query`;
    case "truenas":
      return `${base}/api/v2/system/info`;
    case "generic-smb":
    case "generic-nfs":
      // Best-effort TCP probe via HTTP — providers with no HTTP API just get
      // reported as unreachable, which is accurate for discovery purposes.
      return base;
  }
}

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

  const configs = listProviderConfigs();
  const reachability = await Promise.all(configs.map((p) => checkReachable(probeUrl(p))));
  return NextResponse.json({
    providers: configs.map((p, i) => ({
      id: p.id,
      name: p.name,
      host: p.host,
      port: p.port,
      protocol: p.protocol,
      kind: p.kind,
      backends: p.backends,
      enabled: isProviderEnabled(p),
      reachable: reachability[i],
    })),
  });
}
