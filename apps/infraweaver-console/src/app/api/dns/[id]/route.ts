import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { deleteDnsRecordById, updateDnsRecord } from "@/lib/cloudflare";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";

const patchBodySchema = z.object({
  value: z.string().min(1),
  ttl: z.number().optional(),
});

async function requireAccess() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, "config:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return session;
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireAccess();
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
  const session = await requireAccess();
  if (session instanceof NextResponse) return session;

  try {
    const { id } = await params;
    const rawBody = await req.json().catch(() => null);
    const parsed = patchBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
    }
    const value = parsed.data.value.trim();
    const ttl = typeof parsed.data.ttl === "number" ? Math.max(1, Math.min(86400, Math.round(parsed.data.ttl))) : undefined;

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
