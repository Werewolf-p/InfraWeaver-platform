import { NextResponse } from "next/server";
import { z } from "zod";
import { createDnsRecord, defaultZoneId, listDnsRecords, listZones } from "@/lib/cloudflare";
import {
  buildDnsName,
  buildDnsNameForDomain,
  isInternalDnsName,
  isManagedDnsName,
  isManagedDnsNameForDomain,
  MANAGED_RECORD_TYPES,
  type ManagedDnsRecord,
  type ManagedRecordType,
  relativeDnsName,
  relativeDnsNameForDomain,
} from "@/lib/dns";
import { withAuth } from "@/lib/with-auth";

const createDnsBodySchema = z.object({
  name: z.string().min(1),
  value: z.string().min(1),
  type: z.enum(MANAGED_RECORD_TYPES as unknown as [string, ...string[]]),
  internal: z.boolean().optional(),
  ttl: z.number().optional(),
  zoneId: z.string().optional(),
});

interface RawDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  created_on?: string;
  modified_on?: string;
}

/**
 * Resolve the zone to act on. Returns the explicit zone domain only when a
 * non-default zone is requested; the env default zone keeps `domain: undefined`
 * so the internal/public split below stays exactly as before.
 */
async function resolveSelectedZone(zoneId?: string): Promise<{ zoneId?: string; domain?: string }> {
  const requested = zoneId?.trim();
  if (!requested || requested === defaultZoneId()) {
    return { zoneId: requested || undefined };
  }
  const zone = (await listZones()).find((candidate) => candidate.id === requested);
  return { zoneId: requested, domain: zone?.name };
}

function toManagedRecord(record: RawDnsRecord, zoneDomain?: string): ManagedDnsRecord {
  return {
    id: record.id,
    name: record.name,
    // A non-default zone has no internal/public split, so labels are computed
    // relative to that zone's domain and every record is treated as public.
    shortName: zoneDomain ? relativeDnsNameForDomain(record.name, zoneDomain) : relativeDnsName(record.name),
    type: record.type,
    value: record.content,
    ttl: record.ttl,
    proxied: record.proxied === true,
    internal: zoneDomain ? false : isInternalDnsName(record.name),
    createdAt: record.created_on,
    updatedAt: record.modified_on ?? record.created_on,
  };
}

export const GET = withAuth({ permission: "config:read" }, async ({ req }) => {
  const { zoneId, domain } = await resolveSelectedZone(
    req.nextUrl.searchParams.get("zoneId") ?? undefined,
  );
  const records = await listDnsRecords({}, zoneId);
  const isManaged = (name: string) =>
    domain ? isManagedDnsNameForDomain(name, domain) : isManagedDnsName(name);
  const managedRecords = records
    .filter((record) => isManaged(record.name))
    .map((record) => toManagedRecord(record, domain))
    .filter((record) => MANAGED_RECORD_TYPES.includes(record.type as ManagedRecordType))
    .sort((left, right) => {
      const rightTime = new Date(right.updatedAt ?? right.createdAt ?? 0).getTime();
      const leftTime = new Date(left.updatedAt ?? left.createdAt ?? 0).getTime();
      return rightTime - leftTime || left.name.localeCompare(right.name);
    });

  return NextResponse.json({ records: managedRecords });
});

export const POST = withAuth(
  { permission: "config:write", bodySchema: createDnsBodySchema },
  async ({ body }) => {
    const data = body!;
    const name = data.name.trim();
    const value = data.value.trim();
    const type = data.type.toUpperCase() as ManagedRecordType;
    const internal = data.internal !== false;
    const ttl = typeof data.ttl === "number" ? Math.max(1, Math.min(86400, Math.round(data.ttl))) : 120;

    const { zoneId, domain } = await resolveSelectedZone(data.zoneId);
    // A non-default zone has no internal scope; build the hostname under that
    // zone's domain. The env default zone keeps its internal/public split.
    const fqdn = domain ? buildDnsNameForDomain(name, domain) : buildDnsName(name, internal);

    const record = await createDnsRecord({
      name: fqdn,
      content: value,
      type,
      ttl,
      proxied: false,
    }, zoneId);

    return NextResponse.json({ record: toManagedRecord(record, domain) }, { status: 201 });
  },
);
