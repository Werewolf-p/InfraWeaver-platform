/**
 * Cert-pinned node:https transport for the UDM connector — SERVER ONLY.
 *
 * WHY node:https and not `fetch`: Node's global `fetch` (undici) ignores a
 * custom `https.Agent`, so there is no way to pin the UDM's self-signed cert
 * through it (see `src/lib/insecure-fetch.ts`). We therefore use `node:https`
 * directly, disable CA validation (self-signed), and instead enforce a SHA-256
 * fingerprint pin on the TLS `secureConnect` event — destroying the socket and
 * failing the request if the presented cert is not the exact pinned one. This
 * is stronger than CA trust for a fixed appliance: a MITM would need the pinned
 * key, not merely any cert a public CA will issue.
 */

import https from "node:https";
import { fingerprintsMatch } from "@/lib/udm/fingerprint";
import type { TransportResponse, UdmConfig, UdmTransport } from "@/lib/udm/types";

const DEFAULT_TIMEOUT_MS = 15_000;

/** Build a cert-pinned transport bound to one UDM config. */
export function createHttpsTransport(config: UdmConfig): UdmTransport {
  const base = new URL(config.host);
  if (base.protocol !== "https:") {
    throw new Error("UDM host must be https");
  }
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Reuse one keep-alive agent. rejectUnauthorized:false because the cert is
  // self-signed; the pin (below) is what actually authenticates the server.
  const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });

  return (method, path, body) =>
    new Promise<TransportResponse>((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = https.request(
        {
          agent,
          protocol: base.protocol,
          hostname: base.hostname,
          port: base.port || 443,
          path,
          method,
          timeout,
          headers: {
            "X-API-KEY": config.apiKey,
            Accept: "application/json",
            ...(payload
              ? { "Content-Type": "application/json", "Content-Length": String(payload.length) }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let json: unknown = {};
            if (raw) {
              try {
                json = JSON.parse(raw);
              } catch {
                json = { raw };
              }
            }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );

      // Cert pin: verify the presented leaf cert's fingerprint the moment TLS
      // completes, before any request bytes are trusted.
      req.on("socket", (socket) => {
        socket.on("secureConnect", () => {
          const tls = socket as import("node:tls").TLSSocket;
          const cert = tls.getPeerCertificate();
          const presented = cert?.fingerprint256 ?? "";
          if (!fingerprintsMatch(presented, config.fingerprintSha256)) {
            req.destroy(
              new Error(
                `UDM cert pin mismatch: presented ${presented || "<none>"} does not match pinned fingerprint`,
              ),
            );
          }
        });
      });

      req.on("timeout", () => req.destroy(new Error(`UDM request timed out after ${timeout}ms`)));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
}
