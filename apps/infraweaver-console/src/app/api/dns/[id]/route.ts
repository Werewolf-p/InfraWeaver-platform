import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { deleteDnsRecordById, updateDnsRecord } from "@/lib/cloudflare";
import { safeError } from "@/lib/utils";

async function requireSession() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return session;
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await params;
    await deleteDnsRecordById(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await params;
    const body = await req.json() as { value?: string; ttl?: number };
    const value = typeof body.value === "string" ? body.value.trim() : "";
    const ttl = typeof body.ttl === "number" ? Math.max(1, Math.min(86400, Math.round(body.ttl))) : undefined;

    if (!value) {
      return NextResponse.json({ error: "value is required" }, { status: 400 });
    }

    const record = await updateDnsRecord(id, { content: value, ttl });
    return NextResponse.json({
      record: {
        id: record.id,
        value: record.content,
        ttl: record.ttl,
        updatedAt: record.modified_on ?? record.created_on,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
