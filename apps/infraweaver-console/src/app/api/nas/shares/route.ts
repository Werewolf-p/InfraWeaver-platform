import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasPermission } from "@/lib/rbac";
import { fetchInsecure } from "@/lib/insecure-fetch";

async function synologyLogin(): Promise<string | null> {
  const host = process.env.SYNOLOGY_HOST ?? "10.25.0.21";
  const port = process.env.SYNOLOGY_PORT ?? "5001";
  const user = encodeURIComponent(process.env.SYNOLOGY_USER ?? "");
  const pass = encodeURIComponent(process.env.SYNOLOGY_PASSWORD ?? "");
  if (!user || !pass) return null;

  try {
    const res = await fetchInsecure(`https://${host}:${port}/webapi/auth.cgi?api=SYNO.API.Auth&version=3&method=login&account=${user}&passwd=${pass}&session=FileStation&format=sid`);
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
    const res = await fetchInsecure(`https://${host}:${port}/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list_share&SID=${sid}`);
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
    const res = await fetchInsecure(`https://${host}/api/v2/sharing/smb`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return [];
    const shares = await res.json() as Array<{ name: string; path: string }>;
    return shares.map((share) => ({ name: share.name, path: share.path }));
  } catch {
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
  if (provider === "synology") return NextResponse.json({ shares: await synologyListShares() });
  if (provider === "truenas") return NextResponse.json({ shares: await truenasListShares() });
  return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
}
