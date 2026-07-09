/**
 * TLS certificate-pinned HTTP client for NAS appliances — SERVER ONLY.
 *
 * Why this exists: NAS appliances (TrueNAS, Synology) ship a factory
 * self-signed certificate, so the platform's normal `fetchInternalService`
 * — which fails secure and deliberately has no TLS bypass, see
 * `@/lib/insecure-fetch` — can never authenticate to them. The tempting
 * "fix" is to disable verification, which would leave the NAS admin API key
 * MITM-able by anything on the LAN path.
 *
 * Instead this client verifies the peer certificate against a SHA-256
 * fingerprint the operator explicitly confirmed when the provider was added
 * (trust on first use), and stores that pin alongside the provider:
 *
 *   no pin     → the handshake is aborted BEFORE any request bytes are written
 *                and `NasCertificateUntrustedError` is thrown carrying the
 *                observed certificate, so the UI can ask the operator to
 *                confirm it. Credentials never leave the pod.
 *   mismatch   → `NasCertificateMismatchError`. Fail closed: either the
 *                appliance rotated its certificate or something is in the path.
 *   match      → the request proceeds.
 *
 * Two details that make the guarantee real, and must not be "cleaned up":
 *   - `agent: false` forces a fresh connection per call, so `secureConnect`
 *     always fires and a pooled socket verified against one pin can never be
 *     reused for another.
 *   - the request headers and body are written only from the `secureConnect`
 *     handler, after the pin check passes. `http.ClientRequest` does not
 *     serialise headers until the first `write()`/`end()`, so an aborted
 *     handshake leaks nothing but the SNI hostname.
 *
 * URLs still pass through `parseAllowedInternalUrlAsync`, so the SSRF
 * allowlist applies exactly as it does for `fetchInternalService`.
 */

import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { PeerCertificate, TLSSocket } from "node:tls";
import { parseAllowedInternalUrlAsync } from "@/lib/internal-url-allowlist-server";

const DEFAULT_TIMEOUT_MS = 8_000;
/** Discovery responses are small; refuse to buffer a hostile/huge body. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** The subset of the peer certificate the operator needs in order to trust it. */
export interface NasPeerCertificate {
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  /** Uppercase hex, no separators. */
  fingerprint256: string;
  selfSigned: boolean;
}

export class NasCertificateUntrustedError extends Error {
  readonly code = "NAS_CERT_UNTRUSTED";
  constructor(
    readonly certificate: NasPeerCertificate,
    readonly host: string,
  ) {
    super(`Certificate for ${host} has not been trusted yet`);
    this.name = "NasCertificateUntrustedError";
  }
}

export class NasCertificateMismatchError extends Error {
  readonly code = "NAS_CERT_MISMATCH";
  constructor(
    readonly certificate: NasPeerCertificate,
    readonly host: string,
    readonly expected: string,
  ) {
    super(`Certificate for ${host} does not match the pinned fingerprint`);
    this.name = "NasCertificateMismatchError";
  }
}

export function isNasCertificateError(
  error: unknown,
): error is NasCertificateUntrustedError | NasCertificateMismatchError {
  return error instanceof NasCertificateUntrustedError || error instanceof NasCertificateMismatchError;
}

/** Canonical pin form: uppercase hex, separators stripped. Throws on anything
 *  that is not a SHA-256 digest, so a malformed pin can never widen trust. */
export function normalizeFingerprint(raw: string): string {
  const hex = raw.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
  if (hex.length !== 64) throw new Error("Invalid SHA-256 fingerprint");
  return hex;
}

/** Display form: `AB:CD:…`. */
export function formatFingerprint(fingerprint: string): string {
  return (fingerprint.match(/.{2}/g) ?? []).join(":");
}

type CertName = PeerCertificate["subject"];

function formatDn(name: CertName): string {
  if (!name) return "";
  return Object.entries(name)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("+") : value}`)
    .join(", ");
}

export function toPeerCertificate(peer: PeerCertificate): NasPeerCertificate {
  const subject = formatDn(peer.subject);
  const issuer = formatDn(peer.issuer);
  return {
    subject,
    issuer,
    validFrom: peer.valid_from,
    validTo: peer.valid_to,
    fingerprint256: normalizeFingerprint(peer.fingerprint256),
    selfSigned: subject === issuer,
  };
}

/** Minimal `Response`-alike so call sites read like the `fetch` they replaced. */
export interface NasResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface NasFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface NasFetchOptions {
  /** SHA-256 fingerprint the operator trusted for this provider. Required for https. */
  pin?: string;
}

function collect(res: IncomingMessage, resolve: (r: NasResponse) => void, reject: (e: Error) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  res.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      res.destroy();
      reject(new Error("NAS response exceeded the maximum body size"));
      return;
    }
    chunks.push(chunk);
  });
  res.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const status = res.statusCode ?? 0;
    resolve({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
      json: async () => JSON.parse(body) as unknown,
    });
  });
  res.on("error", reject);
}

/** `URL.hostname` brackets IPv6 literals (`[::1]`), which `net.isIP` rejects. */
function isIpLiteral(hostname: string): boolean {
  return isIP(hostname.replace(/^\[|\]$/g, "")) !== 0;
}

/**
 * Perform an SSRF-allowlisted request to a NAS appliance, verifying its TLS
 * certificate against `options.pin` before any request bytes are written.
 */
export async function fetchNasService(
  rawUrl: string,
  init: NasFetchInit = {},
  options: NasFetchOptions = {},
): Promise<NasResponse> {
  const url = await parseAllowedInternalUrlAsync(rawUrl);
  if (!url) throw new Error("URL not allowed");

  const isHttps = url.protocol === "https:";
  // Normalise eagerly: a malformed stored pin must fail here, not silently
  // fall through to the "no pin" branch and prompt for re-trust.
  const pin = options.pin ? normalizeFingerprint(options.pin) : undefined;
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const body = init.body;

  return new Promise<NasResponse>((resolveRaw, rejectRaw) => {
    // Every terminal path funnels through these so a late `close`/`error` after
    // a resolve — or two failures racing — cannot settle the promise twice, and
    // so the deadline timer is always cleared.
    let settled = false;
    // Armed immediately (no await between here and the request), then pointed at
    // `timedOut` once `req` exists.
    let onDeadline = (): void => {};
    const deadline = setTimeout(() => onDeadline(), timeoutMs);
    const finish = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(deadline);
      return true;
    };
    const resolve = (value: NasResponse): void => {
      if (finish()) resolveRaw(value);
    };
    const reject = (error: Error): void => {
      if (finish()) rejectRaw(error);
    };

    let responded = false;
    const requestFn = isHttps ? httpsRequest : httpRequest;
    const req = requestFn(
      {
        protocol: url.protocol,
        host: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers: {
          ...init.headers,
          ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
        },
        agent: false,
        ...(isHttps
          ? {
              // Verification is done by fingerprint in `secureConnect` below,
              // not by the CA store — appliance certs are self-signed and their
              // CN is rarely the address we dial. Never widen this to a request
              // that is sent without that check.
              rejectUnauthorized: false,
              // SNI is invalid for a bare IP literal (v4 or bracketed v6).
              ...(isIpLiteral(url.hostname) ? {} : { servername: url.hostname }),
            }
          : {}),
      },
      (res) => {
        responded = true;
        collect(res, resolve, reject);
      },
    );

    let sent = false;
    const send = (): void => {
      if (sent) return;
      sent = true;
      if (body) req.write(body);
      req.end();
    };

    // A hard deadline, not an idle timeout: `req.setTimeout` alone resets on
    // every byte, so a trickling peer could hold a "5s probe" open forever.
    const timedOut = (): void => {
      req.destroy(new Error(`NAS request to ${url.hostname} timed out after ${timeoutMs}ms`));
    };
    onDeadline = timedOut;
    req.setTimeout(timeoutMs, timedOut);
    req.on("error", reject);
    // If the socket dies before a response ever arrives, nothing else would
    // settle this promise. `collect` owns every path once a response starts.
    req.on("close", () => {
      if (!responded) reject(new Error(`Connection to ${url.hostname} closed before a response was received`));
    });

    if (!isHttps) {
      send();
      return;
    }

    req.on("socket", (socket) => {
      (socket as TLSSocket).on("secureConnect", () => {
        const tlsSocket = socket as TLSSocket;
        const peer = tlsSocket.getPeerCertificate();
        if (!peer || !peer.fingerprint256) {
          req.destroy(new Error(`${url.hostname} presented no TLS certificate`));
          return;
        }
        let certificate: NasPeerCertificate;
        try {
          certificate = toPeerCertificate(peer);
        } catch (error) {
          req.destroy(error instanceof Error ? error : new Error("Unreadable TLS certificate"));
          return;
        }
        if (!pin) {
          req.destroy(new NasCertificateUntrustedError(certificate, url.hostname));
          return;
        }
        if (certificate.fingerprint256 !== pin) {
          req.destroy(new NasCertificateMismatchError(certificate, url.hostname, pin));
          return;
        }
        send();
      });
    });
  });
}
