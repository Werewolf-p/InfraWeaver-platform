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
  } catch { }
  return null;
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const groups: string[] = (session.user as { groups?: string[] }).groups ?? [];
  if (!hasPermission(groups, "users:read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const provider = req.nextUrl.searchParams.get("provider");
  const share = req.nextUrl.searchParams.get("share");
  if (!provider || !share) return NextResponse.json({ error: "provider and share params required" }, { status: 400 });

  if (provider === "synology") {
    const host = process.env.SYNOLOGY_HOST ?? "10.25.0.21";
    const port = process.env.SYNOLOGY_PORT ?? "5001";
    const sid = await synologyLogin();
    if (!sid) return NextResponse.json({ folders: [] });
    try {
      const folderPath = encodeURIComponent(`/${share}`);
      const url = `https://${host}:${port}/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list&folder_path=${folderPath}&filetype=dir&SID=${sid}`;
      const res = await fetchInsecure(url);
      const data = await res.json() as { success: boolean; data?: { files: Array<{ name: string; path: string }> } };
      if (!data.success) return NextResponse.json({ folders: [] });
      const folders = (data.data?.files ?? []).map(f => ({ name: f.name, path: f.path }));
      return NextResponse.json({ folders });
    } catch {
      return NextResponse.json({ folders: [] });
    }
  } else if (provider === "truenas") {
    const host = process.env.TRUENAS_HOST ?? "10.25.0.135";
    const apiKey = process.env.TRUENAS_API_KEY;
    if (!apiKey) return NextResponse.json({ folders: [] });
    try {
      const res = await fetchInsecure(`https://${host}/api/v2/pool/dataset?type=FILESYSTEM&limit=50`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return NextResponse.json({ folders: [] });
      const datasets = await res.json() as Array<{ name: string; mountpoint?: { value?: string } }>;
      const folders = datasets
        .filter(d => d.name.toLowerCase().includes(share.toLowerCase()))
        .map(d => ({ name: d.name.split("/").pop() ?? d.name, path: d.mountpoint?.value ?? `/${d.name}` }));
      return NextResponse.json({ folders });
    } catch {
      return NextResponse.json({ folders: [] });
    }
  }
  return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
}
