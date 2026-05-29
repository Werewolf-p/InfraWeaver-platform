import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { deleteDnsRecordById, updateDnsRecord } from "@/lib/cloudflare";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import { safeError } from "@/lib/utils";

const patchBodySchema = z.object({
  value: z.string().optional(),
  ttl: z.number().optional(),
  proxied: z.boolean().optional(),
}).refine((body) => (
  typeof body.value === "string"
  || typeof body.ttl === "number"
  || typeof body.proxied === "boolean"
), {
  message: "At least one field is required",
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
    const value = typeof parsed.data.value === "string" ? parsed.data.value.trim() : undefined;
    if (typeof parsed.data.value === "string" && !value) {
      return NextResponse.json({
        error: "Validation failed",
        details: {
          formErrors: [],
          fieldErrors: { value: ["Value cannot be empty"] },
        },
      }, { status: 400 });
    }

    const ttl = typeof parsed.data.ttl === "number" ? Math.max(1, Math.min(86400, Math.round(parsed.data.ttl))) : undefined;
    const proxied = typeof parsed.data.proxied === "boolean" ? parsed.data.proxied : undefined;

    const record = await updateDnsRecord(id, { content: value, ttl, proxied });
    return NextResponse.json({
      record: {
        id: record.id,
        value: record.content,
        ttl: record.ttl,
        proxied: record.proxied === true,
        updatedAt: record.modified_on ?? record.created_on,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
