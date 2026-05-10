import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getARecord, createARecord, deleteARecord } from "@/lib/cloudflare";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;

  const [publicRecord, internalRecord] = await Promise.all([
    getARecord(`${name}.rlservers.com`).catch(() => null),
    getARecord(`${name}.int.rlservers.com`).catch(() => null),
  ]);

  return NextResponse.json({
    public: publicRecord ? { exists: true, ip: publicRecord.content, id: publicRecord.id } : { exists: false },
    internal: internalRecord ? { exists: true, ip: internalRecord.content, id: internalRecord.id } : { exists: false },
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { name } = await params;
  const { ip, publicDns, internalDns } = await req.json() as { ip: string; publicDns: boolean; internalDns: boolean };

  const results: Record<string, unknown> = {};

  if (publicDns) {
    await deleteARecord(`${name}.rlservers.com`).catch(() => {});
    try { results.public = await createARecord(`${name}.rlservers.com`, ip, false); } catch (e) { results.publicError = String(e); }
  }
  if (internalDns) {
    await deleteARecord(`${name}.int.rlservers.com`).catch(() => {});
    try { results.internal = await createARecord(`${name}.int.rlservers.com`, ip, false); } catch (e) { results.internalError = String(e); }
  }

  return NextResponse.json({ success: true, ...results });
}
