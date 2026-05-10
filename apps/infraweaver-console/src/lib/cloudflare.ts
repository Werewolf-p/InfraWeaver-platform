const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ZONE_ID = process.env.CF_ZONE_ID;

const CF_BASE = "https://api.cloudflare.com/client/v4";

function headers() {
  return {
    "Authorization": `Bearer ${CF_TOKEN}`,
    "Content-Type": "application/json",
  };
}

export async function createARecord(name: string, ip: string, proxied = false): Promise<{ id: string }> {
  const res = await fetch(`${CF_BASE}/zones/${CF_ZONE_ID}/dns_records`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ type: "A", name, content: ip, proxied, ttl: proxied ? 1 : 120 }),
  });
  const data = await res.json() as { success: boolean; result: { id: string }; errors: Array<{ message: string }> };
  if (!data.success) throw new Error(data.errors[0]?.message ?? "CF API error");
  return data.result;
}

export async function deleteARecord(name: string): Promise<void> {
  const records = await listARecords(name);
  for (const rec of records) {
    await fetch(`${CF_BASE}/zones/${CF_ZONE_ID}/dns_records/${rec.id}`, {
      method: "DELETE",
      headers: headers(),
    });
  }
}

export async function listARecords(nameFilter?: string): Promise<Array<{ id: string; name: string; content: string; type: string }>> {
  const params = new URLSearchParams({ type: "A", per_page: "100" });
  if (nameFilter) params.set("name", nameFilter);
  const res = await fetch(`${CF_BASE}/zones/${CF_ZONE_ID}/dns_records?${params}`, {
    headers: headers(),
  });
  const data = await res.json() as { success: boolean; result: Array<{ id: string; name: string; content: string; type: string }> };
  if (!data.success) return [];
  return data.result;
}

export async function getARecord(name: string): Promise<{ id: string; name: string; content: string } | null> {
  const records = await listARecords(name);
  return records.find(r => r.name === name) ?? null;
}
