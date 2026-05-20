import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { createDnsRecord, listDnsRecords } from "@/lib/cloudflare";
import { getSessionRBACContext, hasSessionPermission } from "@/lib/session-rbac";
import {
  buildDnsName,
  isInternalDnsName,
  isManagedDnsName,
  MANAGED_RECORD_TYPES,
  type ManagedDnsRecord,
  type ManagedRecordType,
  relativeDnsName,
} from "@/lib/dns";
import { safeError } from "@/lib/utils";

const createDnsBodySchema = z.object({
  name: z.string().min(1),
  value: z.string().min(1),
  type: z.enum(MANAGED_RECORD_TYPES as unknown as [string, ...string[]]),
  internal: z.boolean().optional(),
  ttl: z.number().optional(),
});

function toManagedRecord(record: {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  created_on?: string;
  modified_on?: string;
}): ManagedDnsRecord {
  return {
    id: record.id,
    name: record.name,
    shortName: relativeDnsName(record.name),
    type: record.type,
    value: record.content,
    ttl: record.ttl,
    proxied: record.proxied === true,
    internal: isInternalDnsName(record.name),
    createdAt: record.created_on,
    updatedAt: record.modified_on ?? record.created_on,
  };
}

async function requireAccess(permission: "config:read" | "config:write") {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const access = await getSessionRBACContext(session, 60);
  if (!hasSessionPermission(access, permission)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return session;
}

export async function GET() {
  const session = await requireAccess("config:read");
  if (session instanceof NextResponse) return session;

  try {
    const records = await listDnsRecords();
    const managedRecords = records
      .filter((record) => isManagedDnsName(record.name))
      .map(toManagedRecord)
      .filter((record) => MANAGED_RECORD_TYPES.includes(record.type as ManagedRecordType))
      .sort((left, right) => {
        const rightTime = new Date(right.updatedAt ?? right.createdAt ?? 0).getTime();
        const leftTime = new Date(left.updatedAt ?? left.createdAt ?? 0).getTime();
        return rightTime - leftTime || left.name.localeCompare(right.name);
      });

    return NextResponse.json({ records: managedRecords });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await requireAccess("config:write");
  if (session instanceof NextResponse) return session;

  try {
    const rawBody = await req.json().catch(() => null);
    const parsed = createDnsBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: "Validation failed", details: parsed.error.flatten() }, { status: 400 });
    }

    const name = parsed.data.name.trim();
    const value = parsed.data.value.trim();
    const type = parsed.data.type.toUpperCase() as ManagedRecordType;
    const internal = parsed.data.internal !== false;
    const ttl = typeof parsed.data.ttl === "number" ? Math.max(1, Math.min(86400, Math.round(parsed.data.ttl))) : 120;

    const record = await createDnsRecord({
      name: buildDnsName(name, internal),
      content: value,
      type,
      ttl,
      proxied: false,
    });

    return NextResponse.json({ record: toManagedRecord(record) }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
