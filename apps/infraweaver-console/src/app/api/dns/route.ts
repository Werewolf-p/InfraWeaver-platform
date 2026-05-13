import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createDnsRecord, listDnsRecords } from "@/lib/cloudflare";
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

async function requireSession() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return session;
}

export async function GET() {
  const session = await requireSession();
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
  const session = await requireSession();
  if (session instanceof NextResponse) return session;

  try {
    const body = await req.json() as {
      name?: string;
      value?: string;
      type?: string;
      internal?: boolean;
      ttl?: number;
    };

    const name = String(body.name ?? "").trim();
    const value = String(body.value ?? "").trim();
    const type = String(body.type ?? "").toUpperCase() as ManagedRecordType;
    const internal = body.internal !== false;
    const ttl = typeof body.ttl === "number" ? Math.max(1, Math.min(86400, Math.round(body.ttl))) : 120;

    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    if (!value) {
      return NextResponse.json({ error: "value is required" }, { status: 400 });
    }
    if (!MANAGED_RECORD_TYPES.includes(type)) {
      return NextResponse.json({ error: `type must be one of ${MANAGED_RECORD_TYPES.join(", ")}` }, { status: 400 });
    }

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
