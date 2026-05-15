import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
]);

const BLOCKED_SUFFIXES = [
  ".cluster.local",
  ".int.rlservers.com",
  ".internal",
  ".lan",
  ".local",
  ".localdomain",
  ".svc",
  ".svc.cluster.local",
];

export interface SafeExternalResponse {
  body: Buffer;
  headers: Record<string, string>;
  status: number;
  statusText: string;
}

interface ResolvedExternalUrl {
  address: string;
  family: 4 | 6;
  url: URL;
}

interface SafeExternalRequestOptions {
  body?: Buffer | string;
  headers?: Record<string, string>;
  maxResponseBytes?: number;
  method?: string;
  timeoutMs?: number;
}

interface DnsLookupRecord {
  address: string;
  family: number;
}

function isPrivateIpv4(address: string) {
  const parts = address.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) return true;
  const [first, second] = parts;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function isPrivateIpv6(address: string) {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fe80:") || normalized.startsWith("fec0:")) return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;

  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedIpv4) return isPrivateIpv4(mappedIpv4[1]);

  return false;
}

function normalizeUrl(rawUrl: string | URL) {
  try {
    return rawUrl instanceof URL ? new URL(rawUrl.toString()) : new URL(rawUrl);
  } catch {
    return null;
  }
}

export function isBlockedOutboundHost(hostname: string) {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return true;
  if (BLOCKED_HOSTS.has(normalized)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return true;

  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) return isPrivateIpv4(normalized);
  if (ipVersion === 6) return isPrivateIpv6(normalized);
  return false;
}

export async function parseSafeExternalUrl(rawUrl: string | URL) {
  const url = normalizeUrl(rawUrl);
  if (!url) return null;
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (isBlockedOutboundHost(url.hostname)) return null;

  try {
    const resolved = await dns.lookup(url.hostname, { all: true, verbatim: true });
    if (resolved.some((record) => isBlockedOutboundHost(record.address))) {
      return null;
    }
  } catch {
    // Fall back to hostname checks when DNS lookup is unavailable.
  }

  return url;
}

async function resolveSafeExternalUrl(rawUrl: string | URL): Promise<ResolvedExternalUrl | null> {
  const url = await parseSafeExternalUrl(rawUrl);
  if (!url) return null;

  const resolved = await dns.lookup(url.hostname, { all: true, verbatim: true }).catch(() => [] as DnsLookupRecord[]);
  const safeRecord = resolved.find((record): record is DnsLookupRecord & { family: 4 | 6 } => {
    return (record.family === 4 || record.family === 6) && !isBlockedOutboundHost(record.address);
  });
  if (!safeRecord) return null;

  return {
    address: safeRecord.address,
    family: safeRecord.family,
    url,
  };
}

export async function requestSafeExternalUrl(
  rawUrl: string | URL,
  options: SafeExternalRequestOptions = {},
): Promise<SafeExternalResponse | null> {
  const resolved = await resolveSafeExternalUrl(rawUrl);
  if (!resolved) return null;

  const method = options.method ?? "GET";
  const body = typeof options.body === "string" ? Buffer.from(options.body) : options.body;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const maxResponseBytes = options.maxResponseBytes ?? 1_000_000;
  const headers: Record<string, string> = {
    ...(options.headers ?? {}),
    Host: resolved.url.host,
  };
  if (body && !Object.keys(headers).some((key) => key.toLowerCase() === "content-length")) {
    headers["Content-Length"] = String(body.byteLength);
  }

  return new Promise<SafeExternalResponse>((resolve, reject) => {
    const req = https.request({
      family: resolved.family,
      headers,
      hostname: resolved.address,
      method,
      path: `${resolved.url.pathname}${resolved.url.search}`,
      port: resolved.url.port ? Number.parseInt(resolved.url.port, 10) : 443,
      rejectUnauthorized: true,
      servername: resolved.url.hostname,
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      res.on("data", (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.byteLength;
        if (totalBytes > maxResponseBytes) {
          req.destroy(new Error("Response too large"));
          return;
        }
        chunks.push(buffer);
      });
      res.on("end", () => {
        const responseHeaders: Record<string, string> = {};
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) responseHeaders[key] = value.join(", ");
          else if (typeof value === "string") responseHeaders[key] = value;
        }
        resolve({
          body: Buffer.concat(chunks),
          headers: responseHeaders,
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? "",
        });
      });
      res.on("error", reject);
    });

    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
