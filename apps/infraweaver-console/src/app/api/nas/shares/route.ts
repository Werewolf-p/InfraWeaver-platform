import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { fetchInternalService } from "@/lib/insecure-fetch";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";

async function synologyLogin(): Promise<string | null> {
  const host = process.env.SYNOLOGY_HOST ?? "10.25.0.21";
  const port = process.env.SYNOLOGY_PORT ?? "5001";
  const user = encodeURIComponent(process.env.SYNOLOGY_USER ?? "");
  const pass = encodeURIComponent(process.env.SYNOLOGY_PASSWORD ?? "");
  if (!user || !pass) return null;

  try {
    const res = await fetchInternalService(
      `https://${host}:${port}/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=login&account=${user}&passwd=${pass}&session=FileStation&format=sid`,
      {},
      { allowInsecureTls: true },
    );
    const data = await res.json() as { success: boolean; data?: { sid: string } };
    return data.success ? data.data?.sid ?? null : null;
  } catch {
    return null;
  }
}

async function synologyListShares(): Promise<Array<{ name: string; desc: string; path: string }>> {
  const host = process.env.SYNOLOGY_HOST ?? "10.25.0.21";
  const port = process.env.SYNOLOGY_PORT ?? "5001";
  const sid = await synologyLogin();
  if (!sid) return [];

  try {
    const res = await fetchInternalService(
      `https://${host}:${port}/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list_share&SID=${sid}`,
      {},
      { allowInsecureTls: true },
    );
    const data = await res.json() as { success: boolean; data?: { shares: Array<{ name: string; additional?: { real_path?: string }; desc?: string }> } };
    if (!data.success) return [];
    return (data.data?.shares ?? []).map((share) => ({
      name: share.name,
      desc: share.desc ?? "",
      path: share.additional?.real_path ?? `/${share.name}`,
    }));
  } catch {
    return [];
  }
}

async function truenasListShares(): Promise<Array<{ name: string; path: string }>> {
  const host = process.env.TRUENAS_HOST ?? "10.25.0.135";
  const apiKey = process.env.TRUENAS_API_KEY;
  if (!apiKey) return [];

  try {
    const res = await fetchInternalService(`https://${host}/api/v2/sharing/smb`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    }, { allowInsecureTls: true });
    if (!res.ok) return [];
    const shares = await res.json() as Array<{ name: string; path: string }>;
    return shares.map((share) => ({ name: share.name, path: share.path }));
  } catch {
    return [];
  }
}

async function listSharesForProvider(provider: "synology" | "truenas") {
  if (provider === "synology") {
    return (await synologyListShares()).map((share) => ({ ...share, provider }));
  }

  return (await truenasListShares()).map((share) => ({ ...share, provider }));
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "nas:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!checkRateLimit(rateLimitKey("nas-shares", req), 30, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const provider = req.nextUrl.searchParams.get("provider");
  if (!provider) {
    const [synology, truenas] = await Promise.all([
      listSharesForProvider("synology"),
      listSharesForProvider("truenas"),
    ]);
    return NextResponse.json({ shares: [...synology, ...truenas] });
  }
  if (provider === "synology" || provider === "truenas") {
    return NextResponse.json({ shares: await listSharesForProvider(provider) });
  }
  return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
}
