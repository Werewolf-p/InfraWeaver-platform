import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteDnsRecordById, updateDnsRecord } from "@/lib/cloudflare";
import { withAuth } from "@/lib/with-auth";

const patchBodySchema = z.object({
  value: z.string().optional(),
  ttl: z.number().optional(),
  proxied: z.boolean().optional(),
  zoneId: z.string().optional(),
}).refine((body) => (
  typeof body.value === "string"
  || typeof body.ttl === "number"
  || typeof body.proxied === "boolean"
), {
  message: "At least one field is required",
});

export const DELETE = withAuth<{ id: string }>({ permission: "config:write" }, async ({ req, params }) => {
  const zoneId = req.nextUrl.searchParams.get("zoneId")?.trim() || undefined;
  await deleteDnsRecordById(params.id, zoneId);
  return NextResponse.json({ success: true });
});

export const PATCH = withAuth<{ id: string }, z.infer<typeof patchBodySchema>>(
  { permission: "config:write", bodySchema: patchBodySchema },
  async ({ params, body }) => {
    const data = body!;
    const value = typeof data.value === "string" ? data.value.trim() : undefined;
    if (typeof data.value === "string" && !value) {
      return NextResponse.json({
        error: "Validation failed",
        details: {
          formErrors: [],
          fieldErrors: { value: ["Value cannot be empty"] },
        },
      }, { status: 400 });
    }

    const ttl = typeof data.ttl === "number" ? Math.max(1, Math.min(86400, Math.round(data.ttl))) : undefined;
    const proxied = typeof data.proxied === "boolean" ? data.proxied : undefined;
    const zoneId = data.zoneId?.trim() || undefined;

    const record = await updateDnsRecord(params.id, { content: value, ttl, proxied }, zoneId);
    return NextResponse.json({
      record: {
        id: record.id,
        value: record.content,
        ttl: record.ttl,
        proxied: record.proxied === true,
        updatedAt: record.modified_on ?? record.created_on,
      },
    });
  },
);
