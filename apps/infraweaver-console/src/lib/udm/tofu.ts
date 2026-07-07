/**
 * Trust-on-first-use certificate pinning for the UDM connector — SERVER ONLY.
 *
 * The gateway host is operator-configurable (any LAN IP), so we cannot ship a
 * hardcoded cert fingerprint. Instead, when an admin saves the connector we open
 * one TLS connection to the given host and capture the leaf cert's SHA-256
 * fingerprint, then pin that on every subsequent request (see `https-transport`).
 * Establishing the pin is an authenticated, deliberate admin action — not silent
 * TOFU on arbitrary traffic — so the trust decision is explicit.
 */

import tls from "node:tls";
import { normalizeFingerprint } from "@/lib/udm/fingerprint";

const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Open a TLS connection to `host` (an `https://` URL or bare `host[:port]`) and
 * return the presented leaf certificate's SHA-256 fingerprint as canonical
 * lowercase hex. Self-signed certs are accepted — we are establishing the pin,
 * not validating a CA chain.
 */
export async function fetchServerFingerprint(host: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  const url = new URL(host.includes("://") ? host : `https://${host}`);
  const port = url.port ? Number(url.port) : 443;

  return new Promise<string>((resolve, reject) => {
    const socket = tls.connect(
      {
        host: url.hostname,
        port,
        servername: url.hostname,
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      () => {
        const cert = socket.getPeerCertificate();
        const fingerprint = cert?.fingerprint256 ?? "";
        socket.end();
        if (!fingerprint) {
          reject(new Error("UDM presented no certificate"));
          return;
        }
        resolve(normalizeFingerprint(fingerprint));
      },
    );
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error(`TLS connect to ${url.hostname}:${port} timed out after ${timeoutMs}ms`));
    });
    socket.on("error", (err) => reject(err));
  });
}
