/**
 * Cert-pinned, cookie-authenticated node:https transport for the UDM connector —
 * SERVER ONLY.
 *
 * WHY node:https and not `fetch`: Node's global `fetch` (undici) ignores a custom
 * `https.Agent`, so there is no way to pin the UDM's self-signed cert through it.
 * We use `node:https` directly, disable CA validation, and enforce a SHA-256
 * fingerprint pin on the TLS `secureConnect` event instead.
 *
 * WHY cookie auth and not X-API-KEY: this UDM firmware rejects API keys on the
 * local Network API (401 on every endpoint). The working scheme is the UniFi OS
 * login: prime cookies with `GET /`, `POST /api/auth/login` with username +
 * password to obtain the session cookie + CSRF token, then send the cookie on
 * every request and `X-CSRF-Token` on mutations. The session is established
 * lazily on first use and re-established once on a 401.
 */

import https from "node:https";
import { fingerprintsMatch } from "@/lib/udm/fingerprint";
import type { TransportResponse, UdmConfig, UdmTransport } from "@/lib/udm/types";

const DEFAULT_TIMEOUT_MS = 15_000;

interface RawResponse {
  status: number;
  headers: import("node:http").IncomingHttpHeaders;
  body: string;
}

/** Build a cert-pinned, cookie-authenticated transport bound to one UDM config. */
export function createHttpsTransport(config: UdmConfig): UdmTransport {
  const base = new URL(config.host);
  if (base.protocol !== "https:") {
    throw new Error("UDM host must be https");
  }
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const agent = new https.Agent({ keepAlive: true, rejectUnauthorized: false });

  // Session state, established by login() and reused across calls on this client.
  let cookie: string | null = null;
  let csrfToken: string | null = null;
  let loginPromise: Promise<void> | null = null;

  function rawRequest(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<RawResponse> {
    return new Promise<RawResponse>((resolve, reject) => {
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
            Accept: "application/json",
            ...headers,
            ...(payload
              ? { "Content-Type": "application/json", "Content-Length": String(payload.length) }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
          );
        },
      );

      // Cert pin: verify the presented leaf cert the moment TLS completes.
      req.on("socket", (socket) => {
        socket.on("secureConnect", () => {
          const tls = socket as import("node:tls").TLSSocket;
          const presented = tls.getPeerCertificate()?.fingerprint256 ?? "";
          if (!fingerprintsMatch(presented, config.fingerprintSha256)) {
            req.destroy(
              new Error(`UDM cert pin mismatch: presented ${presented || "<none>"} does not match pinned fingerprint`),
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

  /** Absorb any session cookie / rotating CSRF token from a response. */
  function captureSession(res: RawResponse): void {
    const setCookie = res.headers["set-cookie"];
    if (Array.isArray(setCookie) && setCookie.length > 0) {
      cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    }
    const csrf = res.headers["x-csrf-token"] ?? res.headers["x-updated-csrf-token"];
    if (typeof csrf === "string" && csrf) csrfToken = csrf;
  }

  async function login(): Promise<void> {
    const primed = await rawRequest("GET", "/", undefined, {});
    captureSession(primed);
    const headers: Record<string, string> = { Origin: config.host, Referer: `${config.host}/` };
    if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
    const res = await rawRequest(
      "POST",
      "/api/auth/login",
      { username: config.username, password: config.password, rememberMe: false },
      headers,
    );
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`UDM login failed (HTTP ${res.status})`);
    }
    captureSession(res);
    if (!cookie) throw new Error("UDM login did not return a session cookie");
  }

  async function ensureLogin(): Promise<void> {
    if (cookie) return;
    if (!loginPromise) {
      loginPromise = login().catch((err) => {
        loginPromise = null;
        throw err;
      });
    }
    await loginPromise;
  }

  function authHeaders(method: string): Record<string, string> {
    const headers: Record<string, string> = { Origin: config.host, Referer: `${config.host}/` };
    if (cookie) headers["Cookie"] = cookie;
    if (csrfToken && method !== "GET") headers["X-CSRF-Token"] = csrfToken;
    return headers;
  }

  return async (method, path, body): Promise<TransportResponse> => {
    await ensureLogin();
    let res = await rawRequest(method, path, body, authHeaders(method));
    captureSession(res);
    if (res.status === 401) {
      // Session expired or invalid — re-authenticate once and retry.
      cookie = null;
      csrfToken = null;
      loginPromise = null;
      await ensureLogin();
      res = await rawRequest(method, path, body, authHeaders(method));
      captureSession(res);
    }
    let json: unknown = {};
    if (res.body) {
      try {
        json = JSON.parse(res.body);
      } catch {
        json = { raw: res.body };
      }
    }
    return { status: res.status, json };
  };
}
