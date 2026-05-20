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

function assertCloudflareConfig() {
  if (!CF_TOKEN || !CF_ZONE_ID) {
    throw new Error("Cloudflare DNS is not configured");
  }
}

function headers() {
  assertCloudflareConfig();
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

export async function listDnsRecords(filters: {
  type?: string;
  name?: string;
  perPage?: number;
} = {}): Promise<CloudflareDnsRecord[]> {
  const perPage = filters.perPage ?? 100;
  let page = 1;
  let totalPages = 1;
  const records: CloudflareDnsRecord[] = [];

  while (page <= totalPages) {
    const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
    if (filters.type) params.set("type", filters.type);
    if (filters.name) params.set("name", filters.name);

    const response = await cfRequest<CloudflareDnsRecord[]>(`/zones/${CF_ZONE_ID}/dns_records?${params}`);
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
}) {
  return cfFetch<CloudflareDnsRecord>(`/zones/${CF_ZONE_ID}/dns_records`, {
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
) {
  return cfFetch<CloudflareDnsRecord>(`/zones/${CF_ZONE_ID}/dns_records/${id}`, {
    method: "PATCH",
    body: JSON.stringify({
      ...(typeof input.content === "string" ? { content: input.content } : {}),
      ...(typeof input.ttl === "number" ? { ttl: input.ttl } : {}),
      ...(typeof input.proxied === "boolean" ? { proxied: input.proxied } : {}),
    }),
  });
}

export async function deleteDnsRecordById(id: string): Promise<void> {
  await cfFetch(`/zones/${CF_ZONE_ID}/dns_records/${id}`, { method: "DELETE" });
}

export async function createARecord(name: string, ip: string, proxied = false): Promise<{ id: string }> {
  const record = await createDnsRecord({
    type: "A",
    name,
    content: ip,
    proxied,
    ttl: proxied ? 1 : 120,
  });
  return { id: record.id };
}

export async function deleteARecord(name: string): Promise<void> {
  const records = await listARecords(name);
  await Promise.all(records.map((record) => deleteDnsRecordById(record.id)));
}

export async function listARecords(nameFilter?: string): Promise<Array<{ id: string; name: string; content: string; type: string }>> {
  const records = await listDnsRecords({ type: "A", ...(nameFilter ? { name: nameFilter } : {}) });
  return records.map(({ id, name, content, type }) => ({ id, name, content, type }));
}

export async function getARecord(name: string): Promise<{ id: string; name: string; content: string } | null> {
  const records = await listARecords(name);
  return records.find((record) => record.name === name) ?? null;
}
