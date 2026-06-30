const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ZONE_ID = process.env.CF_ZONE_ID;

const CF_BASE = "https://api.cloudflare.com/client/v4";

interface CloudflareEnvelope<T> {
  success: boolean;
  result: T;
  errors: Array<{ message?: string }>;
  result_info?: {
    page: number;
    per_page: number;
    total_pages: number;
    total_count: number;
  };
}

export interface CloudflareDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  created_on?: string;
  modified_on?: string;
}

export interface CloudflareZone {
  id: string;
  name: string;
  status: string;
}

function assertToken(): void {
  if (!CF_TOKEN) throw new Error("Cloudflare API token is not configured");
}

/** Whether a Cloudflare API token is present — domains go dynamic only when true. */
export function cloudflareConfigured(): boolean {
  return !!CF_TOKEN;
}

/** The env-configured default zone id (CF_ZONE_ID), or undefined when unset. */
export function defaultZoneId(): string | undefined {
  const id = CF_ZONE_ID?.trim();
  return id ? id : undefined;
}

/**
 * Best-effort variant of {@link resolveZoneId}: returns the id of the managed
 * zone covering `name`, or `undefined` when Cloudflare is unconfigured or no
 * zone matches. Callers fall back to the env default zone on `undefined`, so
 * single-zone deployments keep working unchanged.
 */
export async function resolveZoneIdForHost(name: string): Promise<string | undefined> {
  if (!cloudflareConfigured()) return undefined;
  try {
    return await resolveZoneId(name);
  } catch {
    return undefined;
  }
}

/** Resolve the zone a record-level call targets: an explicit id, else the env default. */
function requireZoneId(zoneId?: string): string {
  const id = (zoneId ?? CF_ZONE_ID ?? "").trim();
  if (!id) throw new Error("Cloudflare zone is not configured");
  return id;
}

function headers() {
  assertToken();
  return {
    Authorization: `Bearer ${CF_TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function cfRequest<T>(path: string, options?: RequestInit): Promise<CloudflareEnvelope<T>> {
  const res = await fetch(`${CF_BASE}${path}`, {
    ...options,
    cache: "no-store",
    headers: {
      ...headers(),
      ...options?.headers,
    },
  });
  const data = await res.json() as CloudflareEnvelope<T>;
  if (!res.ok || !data.success) {
    throw new Error(data.errors?.[0]?.message ?? `Cloudflare API request failed (${res.status})`);
  }
  return data;
}

export async function cfFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const data = await cfRequest<T>(path, options);
  return data.result;
}

/**
 * Every zone the configured API token can manage. A zone-scoped token returns
 * exactly the zones in its scope, so this is the authoritative set of domains an
 * operator can deploy under — no domain list is ever hardcoded. Paginated.
 */
export async function listZones(): Promise<CloudflareZone[]> {
  const perPage = 50;
  let page = 1;
  let totalPages = 1;
  const zones: CloudflareZone[] = [];

  while (page <= totalPages) {
    const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
    const response = await cfRequest<CloudflareZone[]>(`/zones?${params}`);
    zones.push(...(response.result ?? []));
    totalPages = response.result_info?.total_pages ?? 1;
    page += 1;
  }

  return zones;
}

/**
 * The id of the zone that manages `name`, chosen as the longest zone whose name is
 * `name` itself or a suffix of it (so `blog.example.com` resolves to the
 * `example.com` zone). Throws when no managed zone covers the name.
 */
export async function resolveZoneId(name: string): Promise<string> {
  const host = name.trim().toLowerCase();
  const match = (await listZones())
    .filter((z) => host === z.name.toLowerCase() || host.endsWith(`.${z.name.toLowerCase()}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!match) throw new Error(`No Cloudflare zone manages "${name}"`);
  return match.id;
}

export async function listDnsRecords(filters: {
  type?: string;
  name?: string;
  perPage?: number;
} = {}, zoneId?: string): Promise<CloudflareDnsRecord[]> {
  const zone = requireZoneId(zoneId);
  const perPage = filters.perPage ?? 100;
  let page = 1;
  let totalPages = 1;
  const records: CloudflareDnsRecord[] = [];

  while (page <= totalPages) {
    const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
    if (filters.type) params.set("type", filters.type);
    if (filters.name) params.set("name", filters.name);

    const response = await cfRequest<CloudflareDnsRecord[]>(`/zones/${zone}/dns_records?${params}`);
    records.push(...(response.result ?? []));
    totalPages = response.result_info?.total_pages ?? 1;
    page += 1;
  }

  return records;
}

export async function createDnsRecord(input: {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean;
}, zoneId?: string) {
  return cfFetch<CloudflareDnsRecord>(`/zones/${requireZoneId(zoneId)}/dns_records`, {
    method: "POST",
    body: JSON.stringify({
      type: input.type,
      name: input.name,
      content: input.content,
      ttl: input.ttl ?? (input.proxied ? 1 : 120),
      ...(typeof input.proxied === "boolean" ? { proxied: input.proxied } : {}),
    }),
  });
}

export async function updateDnsRecord(
  id: string,
  input: { content?: string; ttl?: number; proxied?: boolean },
  zoneId?: string,
) {
  return cfFetch<CloudflareDnsRecord>(`/zones/${requireZoneId(zoneId)}/dns_records/${id}`, {
    method: "PATCH",
    body: JSON.stringify({
      ...(typeof input.content === "string" ? { content: input.content } : {}),
      ...(typeof input.ttl === "number" ? { ttl: input.ttl } : {}),
      ...(typeof input.proxied === "boolean" ? { proxied: input.proxied } : {}),
    }),
  });
}

export async function deleteDnsRecordById(id: string, zoneId?: string): Promise<void> {
  await cfFetch(`/zones/${requireZoneId(zoneId)}/dns_records/${id}`, { method: "DELETE" });
}

export async function createARecord(name: string, ip: string, proxied = false, zoneId?: string): Promise<{ id: string }> {
  const record = await createDnsRecord({
    type: "A",
    name,
    content: ip,
    proxied,
    ttl: proxied ? 1 : 120,
  }, zoneId);
  return { id: record.id };
}

export async function deleteARecord(name: string, zoneId?: string): Promise<void> {
  const records = await listARecords(name, zoneId);
  await Promise.all(records.map((record) => deleteDnsRecordById(record.id, zoneId)));
}

export async function listARecords(nameFilter?: string, zoneId?: string): Promise<Array<{ id: string; name: string; content: string; type: string }>> {
  const records = await listDnsRecords({ type: "A", ...(nameFilter ? { name: nameFilter } : {}) }, zoneId);
  return records.map(({ id, name, content, type }) => ({ id, name, content, type }));
}

export async function getARecord(name: string, zoneId?: string): Promise<{ id: string; name: string; content: string } | null> {
  const records = await listARecords(name, zoneId);
  return records.find((record) => record.name === name) ?? null;
}

/**
 * Create-or-update a CNAME for `name` → `target`. Idempotent: a re-provision
 * updates the existing record rather than failing on "record already exists". Any
 * conflicting A record at the same name is removed first (CNAME and A cannot
 * coexist on one name).
 */
export async function upsertCnameRecord(name: string, target: string, proxied = false, zoneId?: string): Promise<{ id: string }> {
  const conflicting = await listDnsRecords({ type: "A", name }, zoneId);
  await Promise.all(conflicting.filter((r) => r.name === name).map((r) => deleteDnsRecordById(r.id, zoneId)));
  const existing = (await listDnsRecords({ type: "CNAME", name }, zoneId)).find((r) => r.name === name);
  if (existing) {
    await updateDnsRecord(existing.id, { content: target, proxied, ttl: proxied ? 1 : 120 }, zoneId);
    return { id: existing.id };
  }
  const record = await createDnsRecord({ type: "CNAME", name, content: target, proxied, ttl: proxied ? 1 : 120 }, zoneId);
  return { id: record.id };
}

/** Delete every DNS record (any type) for `name` — used when tearing a site down. */
export async function deleteRecordsByName(name: string, zoneId?: string): Promise<void> {
  const records = await listDnsRecords({ name }, zoneId);
  await Promise.all(records.filter((r) => r.name === name).map((r) => deleteDnsRecordById(r.id, zoneId)));
}
