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
      const res = await fetchInsecure(`https://${host}:${port}/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list&folder_path=${folderPath}&filetype=dir&SID=${sid}`);
      const data = await res.json() as { success: boolean; data?: { files: Array<{ name: string; path: string }> } };
      if (!data.success) return NextResponse.json({ folders: [] });
      return NextResponse.json({ folders: (data.data?.files ?? []).map((file) => ({ name: file.name, path: file.path })) });
    } catch {
      return NextResponse.json({ folders: [] });
    }
  }

  if (provider === "truenas") {
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
        .filter((dataset) => dataset.name.toLowerCase().includes(share.toLowerCase()))
        .map((dataset) => ({
          name: dataset.name.split("/").pop() ?? dataset.name,
          path: dataset.mountpoint?.value ?? `/${dataset.name}`,
        }));
      return NextResponse.json({ folders });
    } catch {
      return NextResponse.json({ folders: [] });
    }
  }

  return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
}
