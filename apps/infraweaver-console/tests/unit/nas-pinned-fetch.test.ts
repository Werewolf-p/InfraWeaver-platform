/**
 * @jest-environment node
 *
 * Exercises the NAS TLS pin against a real self-signed HTTPS server: an
 * unpinned request must abort the handshake WITHOUT sending the request (so a
 * credential header can never reach an untrusted peer), a wrong pin must fail
 * closed, and only the exact fingerprint may proceed.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import {
  NasCertificateMismatchError,
  NasCertificateUntrustedError,
  fetchNasService,
  formatFingerprint,
  normalizeFingerprint,
} from "@/lib/nas/pinned-fetch";

// The pin client is SSRF-gated by the shared allowlist; loopback is allowed in
// the real implementation too, but stub it so the test never reads cluster env.
jest.mock("@/lib/internal-url-allowlist-server", () => ({
  parseAllowedInternalUrlAsync: jest.fn(async (raw: string) => {
    const url = new URL(raw);
    return url.hostname === "127.0.0.1" ? url : null;
  }),
}));

const WRONG_PIN = "A".repeat(64);

let dir: string;
let server: Server;
let port: number;
let fingerprint: string;
/** Request paths the server actually received — proves nothing was sent. */
let hits: string[];
let authHeaders: (string | undefined)[];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "nas-pin-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", key, "-out", cert, "-days", "1",
    "-subj", "/CN=localhost/O=InfraWeaver Test",
  ], { stdio: "ignore" });

  // `openssl … -fingerprint` prints `SHA256 Fingerprint=AA:BB:…`; the label
  // itself contains hex letters, so take only the value.
  const printed = execFileSync("openssl", ["x509", "-in", cert, "-noout", "-fingerprint", "-sha256"]).toString();
  fingerprint = normalizeFingerprint(printed.split("=")[1] ?? "");

  hits = [];
  authHeaders = [];
  server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    hits.push(req.url ?? "");
    authHeaders.push(req.headers.authorization);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hostname: "truenas" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const url = () => `https://127.0.0.1:${port}/api/v2.0/system/info`;

describe("fingerprint helpers", () => {
  test("normalizes a colon-separated fingerprint to bare uppercase hex", () => {
    // Arrange
    const raw = "b3:bb:6d:ce:a3:62:58:3b:09:d2:ff:5f:31:73:ff:7d:57:94:84:3e:4e:21:f4:e7:1d:54:f7:f2:f0:e4:d3:8a";

    // Act
    const normalized = normalizeFingerprint(raw);

    // Assert
    expect(normalized).toBe("B3BB6DCEA362583B09D2FF5F3173FF7D5794843E4E21F4E71D54F7F2F0E4D38A");
  });

  test("throws when the value is not a SHA-256 digest", () => {
    expect(() => normalizeFingerprint("AB:CD")).toThrow("Invalid SHA-256 fingerprint");
  });

  test("formats a bare digest back into colon-separated display form", () => {
    expect(formatFingerprint("AABB")).toBe("AA:BB");
  });
});

describe("fetchNasService TLS pinning", () => {
  test("rejects an unpinned request and never sends it to the peer", async () => {
    // Arrange
    const before = hits.length;

    // Act
    const error = await fetchNasService(url(), { headers: { Authorization: "Bearer secret-admin-key" } })
      .then(() => null)
      .catch((e: unknown) => e);

    // Assert
    expect(error).toBeInstanceOf(NasCertificateUntrustedError);
    const untrusted = error as NasCertificateUntrustedError;
    expect(untrusted.certificate.fingerprint256).toBe(fingerprint);
    expect(untrusted.certificate.selfSigned).toBe(true);
    expect(untrusted.certificate.subject).toContain("CN=localhost");
    // The credential must not have reached an unverified server.
    expect(hits.length).toBe(before);
    expect(authHeaders).not.toContain("Bearer secret-admin-key");
  });

  test("rejects a mismatched pin and never sends the request", async () => {
    // Arrange
    const before = hits.length;

    // Act
    const error = await fetchNasService(url(), { headers: { Authorization: "Bearer secret-admin-key" } }, { pin: WRONG_PIN })
      .then(() => null)
      .catch((e: unknown) => e);

    // Assert
    expect(error).toBeInstanceOf(NasCertificateMismatchError);
    expect((error as NasCertificateMismatchError).expected).toBe(WRONG_PIN);
    expect(hits.length).toBe(before);
  });

  test("allows the request when the pin matches the peer certificate", async () => {
    // Act
    const res = await fetchNasService(url(), { headers: { Authorization: "Bearer scoped-key" } }, { pin: fingerprint });

    // Assert
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hostname: "truenas" });
    expect(hits).toContain("/api/v2.0/system/info");
    expect(authHeaders).toContain("Bearer scoped-key");
  });

  test("accepts a colon-separated pin as stored by the operator", async () => {
    // Act
    const res = await fetchNasService(url(), {}, { pin: formatFingerprint(fingerprint) });

    // Assert
    expect(res.ok).toBe(true);
  });

  test("throws before connecting when the stored pin is malformed", async () => {
    await expect(fetchNasService(url(), {}, { pin: "not-a-fingerprint" })).rejects.toThrow(
      "Invalid SHA-256 fingerprint",
    );
  });

  test("refuses a host outside the SSRF allowlist", async () => {
    await expect(fetchNasService("https://example.com/api", {}, { pin: fingerprint })).rejects.toThrow(
      "URL not allowed",
    );
  });
});

describe("fetchNasService request lifecycle", () => {
  test("enforces a hard deadline, not an idle timeout, against a trickling peer", async () => {
    // Arrange: a server that dribbles a byte forever. An idle timeout would
    // keep resetting and never fire.
    const trickler = createServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      const timer = setInterval(() => res.write(" "), 30);
      res.on("close", () => clearInterval(timer));
    });
    await new Promise<void>((resolve) => trickler.listen(0, "127.0.0.1", resolve));
    const tricklePort = (trickler.address() as AddressInfo).port;

    // Act
    const started = process.hrtime.bigint();
    const error = await fetchNasService(`https://127.0.0.1:${tricklePort}/`, { timeoutMs: 250 }, { pin: fingerprint })
      .then(() => null)
      .catch((e: unknown) => e);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    // Assert
    expect((error as Error).message).toMatch(/timed out after 250ms/);
    expect(elapsedMs).toBeLessThan(2000);
    await new Promise<void>((resolve) => trickler.close(() => resolve()));
  });

  test("rejects rather than hanging when the peer closes without responding", async () => {
    // Arrange: accept the TLS handshake, then drop the connection.
    const rude = createServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (req) => {
      req.socket.destroy();
    });
    await new Promise<void>((resolve) => rude.listen(0, "127.0.0.1", resolve));
    const rudePort = (rude.address() as AddressInfo).port;

    // Act + Assert: must settle, not hang until jest's timeout.
    await expect(
      fetchNasService(`https://127.0.0.1:${rudePort}/`, { timeoutMs: 5000 }, { pin: fingerprint }),
    ).rejects.toThrow(/closed before a response was received|socket hang up/);
    await new Promise<void>((resolve) => rude.close(() => resolve()));
  });
});
