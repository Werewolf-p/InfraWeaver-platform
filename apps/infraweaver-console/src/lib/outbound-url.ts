import crypto from "node:crypto";
import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

import { INTERNAL_DOMAIN } from "@/lib/domain";

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
]);

const BLOCKED_SUFFIXES = [
  ".cluster.local",
  `.${INTERNAL_DOMAIN}`,
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
  /**
   * SHA-256 of the peer leaf certificate's SubjectPublicKeyInfo, base64 — the
   * standard `sha256//` SPKI pin value. Present on HTTPS responses so a caller
   * can capture/compare the served certificate's pin (§ IWSL cert pinning). A
   * pin is stable across CA renewals as long as the key is reused.
   */
  peerSpki?: string;
}

/**
 * The base64 SHA-256 SPKI pin for a DER-encoded X.509 certificate — identical
 * to `openssl x509 -pubkey | openssl pkey -pubin -outform der | openssl dgst
 * -sha256 -binary | base64` and to a browser/HPKP `sha256//<b64>` pin. We pin
 * the SubjectPublicKeyInfo, not the whole leaf, so the pin survives certificate
 * renewals that reuse the key (OWASP guidance).
 */
export function spkiSha256Pin(certDer: Buffer): string {
  const spkiDer = new crypto.X509Certificate(certDer).publicKey.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(spkiDer).digest("base64");
}

/**
 * True when any certificate in the presented chain (leaf → root) matches any
 * pin in the set — the backup-pin model that lets a key rotation overlap
 * old+new without a bricked connection. Walks issuers, terminating on the
 * self-signed root (which references itself).
 */
function chainMatchesPin(leaf: tls.DetailedPeerCertificate, pins: Set<string>): boolean {
  let cert: tls.DetailedPeerCertificate | undefined = leaf;
  const seenFingerprints = new Set<string>();
  while (cert && cert.raw && cert.raw.length > 0) {
    try {
      if (pins.has(spkiSha256Pin(cert.raw))) return true;
    } catch {
      // A cert we cannot parse cannot satisfy a pin — keep walking the chain.
    }
    const fingerprint = cert.fingerprint256 ?? "";
    if (seenFingerprints.has(fingerprint)) break; // self-signed root loops to itself
    seenFingerprints.add(fingerprint);
    cert = cert.issuerCertificate;
  }
  return false;
}

/**
 * A `checkServerIdentity` that keeps Node's built-in hostname/SAN validation
 * (overriding it would otherwise silently disable that check) and then, if a
 * pin-set is supplied, additionally requires the chain to match a pinned SPKI.
 * Fails closed on mismatch — the connection is dropped during the handshake,
 * before the plugin ever sees a byte.
 */
function makeServerIdentityCheck(pinnedSpki: string[] | undefined) {
  const pins = pinnedSpki && pinnedSpki.length > 0 ? new Set(pinnedSpki) : null;
  return (hostname: string, cert: tls.PeerCertificate): Error | undefined => {
    const identityError = tls.checkServerIdentity(hostname, cert);
    if (identityError) return identityError;
    if (!pins) return undefined;
    return chainMatchesPin(cert as tls.DetailedPeerCertificate, pins)
      ? undefined
      : new Error(`TLS certificate pin mismatch for ${hostname}`);
  };
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
  /**
   * Certificate SPKI pin-set (base64 SHA-256, `sha256//` values without the
   * prefix). When non-empty, the TLS handshake fails closed unless the served
   * chain matches a pin — defence-in-depth on top of the app-layer signatures,
   * catching a hijacked-DNS or mis-issued-CA endpoint before any request body
   * is sent. Empty/omitted keeps standard CA validation only.
   */
  pinnedSpki?: string[];
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

  // The WHATWG URL parser serializes IPv4-mapped literals in compressed hex
  // (e.g. [::ffff:127.0.0.1] → ::ffff:7f00:1), which the dotted form above
  // never matches — decode the two hextets back to dotted quad.
  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isPrivateIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }

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
  // URL.hostname keeps the brackets on IPv6 literals ("[::1]"), which
  // net.isIP does not recognise — strip them or the literal skips the
  // private-range checks entirely.
  const normalized = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
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

  // Raw IP literals were already vetted above and need no DNS step.
  if (net.isIP(url.hostname.replace(/^\[(.*)\]$/, "$1")) !== 0) return url;

  try {
    const resolved = await dns.lookup(url.hostname, { all: true, verbatim: true });
    if (resolved.length === 0 || resolved.some((record) => isBlockedOutboundHost(record.address))) {
      return null;
    }
  } catch {
    // Fail closed: a hostname we cannot resolve cannot be vetted against the
    // private-range blocklist, and no later fetch would succeed anyway.
    return null;
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
      checkServerIdentity: makeServerIdentityCheck(options.pinnedSpki),
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
        let peerSpki: string | undefined;
        const socket = res.socket as tls.TLSSocket | undefined;
        const peerCert = socket?.getPeerCertificate?.(false);
        if (peerCert && peerCert.raw && peerCert.raw.length > 0) {
          try {
            peerSpki = spkiSha256Pin(peerCert.raw);
          } catch {
            // Non-fatal: capture is best-effort; enforcement (if any) already ran.
          }
        }
        resolve({
          body: Buffer.concat(chunks),
          headers: responseHeaders,
          status: res.statusCode ?? 0,
          statusText: res.statusMessage ?? "",
          peerSpki,
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
