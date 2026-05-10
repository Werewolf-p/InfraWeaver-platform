import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";

async function fetchInsecure(url: string, init?: RequestInit): Promise<Response> {
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(8000), cache: "no-store" });
  } finally {
    if (prev !== undefined) process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    else delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  }
}

async function synologyLogin(): Promise<string | null> {
  const host = process.env.SYNOLOGY_HOST ?? "10.25.0.21";
  const port = process.env.SYNOLOGY_PORT ?? "5001";
  const user = encodeURIComponent(process.env.SYNOLOGY_USER ?? "Remon");
  const pass = encodeURIComponent(process.env.SYNOLOGY_PASSWORD ?? "CodeRE52");
  try {
    const url = `https://${host}:${port}/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=login&account=${user}&passwd=${pass}&session=FileStation&format=sid`;
    const res = await fetchInsecure(url);
    const data = await res.json() as { success: boolean; data?: { sid: string } };
    if (data.success) return data.data?.sid ?? null;
  } catch (e) {
    console.error("Synology login failed:", e);
  }
  return null;
}

async function synologyListShares(): Promise<Array<{ name: string; desc: string; path: string }>> {
  const host = process.env.SYNOLOGY_HOST ?? "10.25.0.21";
  const port = process.env.SYNOLOGY_PORT ?? "5001";
  const sid = await synologyLogin();
  if (!sid) return [];
  try {
    const url = `https://${host}:${port}/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list_share&SID=${sid}`;
    const res = await fetchInsecure(url);
    const data = await res.json() as { success: boolean; data?: { shares: Array<{ name: string; additional?: { real_path?: string }; desc?: string }> } };
    if (!data.success) return [];
    return (data.data?.shares ?? []).map(s => ({
      name: s.name,
      desc: s.desc ?? "",
      path: s.additional?.real_path ?? `/${s.name}`,
    }));
  } catch (e) {
    console.error("Synology list shares failed:", e);
    return [];
  }
}

async function truenasListShares(): Promise<Array<{ name: string; path: string }>> {
  const host = process.env.TRUENAS_HOST ?? "10.25.0.135";
  const apiKey = process.env.TRUENAS_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetchInsecure(`https://${host}/api/v2/sharing/smb`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];
    const shares = await res.json() as Array<{ name: string; path: string }>;
    return shares.map(s => ({ name: s.name, path: s.path }));
  } catch (e) {
    console.error("TrueNAS list shares failed:", e);
    return [];
  }
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "users:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const provider = req.nextUrl.searchParams.get("provider");
  if (!provider) return NextResponse.json({ error: "provider param required" }, { status: 400 });

  if (provider === "synology") {
    const shares = await synologyListShares();
    return NextResponse.json({ shares });
  } else if (provider === "truenas") {
    const shares = await truenasListShares();
    return NextResponse.json({ shares });
  }
  return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
}
