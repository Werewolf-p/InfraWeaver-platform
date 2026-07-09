/**
 * @jest-environment node
 *
 * The NAS wizard's allowlist chicken-and-egg: `isAllowedInternalHostForWizard`
 * admits any unambiguously-private host, but `fetchNasService` resolves its SSRF
 * allowlist from env/git + the STORED providers — and a provider is stored only
 * after its save-and-test probe succeeds. So a NAS box that was not already in
 * `DEFAULT_INTERNAL_HOST_ALLOWLIST` could never be added: the probe died with
 * "URL not allowed" before it ever saw the appliance.
 *
 * These tests pin the fix: the wizard threads its already-validated host down to
 * the probe as `wizardHost`, which admits exactly that one private host for that
 * one call — a fresh RFC1918 address now reaches the appliance and comes back as
 * the 409 certificate challenge. Ordinary (non-wizard) fetches are unchanged.
 *
 * `10.42.0.99` is not routable from the test runner, so `node:https` is
 * redirected to a loopback listener AFTER the SSRF gate has already decided.
 * Everything the tests actually assert on — the allowlist decision, the TLS
 * handshake, the pin check, the 409 body — is real.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

jest.mock("server-only", () => ({}), { virtual: true });

// next/server is ESM-only under Jest; NextResponse.json becomes a plain object.
jest.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
  NextRequest: class {},
}));

jest.mock("@/lib/auth", () => ({ auth: jest.fn(async () => ({ user: { email: "op@example.com" } })) }));
jest.mock("@/lib/session-rbac", () => ({
  getSessionRBACContext: jest.fn(async () => ({})),
  hasSessionPermission: jest.fn(() => true),
}));
jest.mock("@/lib/rate-limit", () => ({
  checkRateLimit: jest.fn(() => true),
  rateLimitKey: jest.fn(() => "test-key"),
}));
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn(async () => undefined) }));
jest.mock("@/lib/access-log", () => ({ logMutatingAccess: jest.fn() }));
jest.mock("@/lib/nas/providers", () => ({
  listProviderConfigs: jest.fn(() => []),
  resolveNasProviders: jest.fn(async () => []),
}));

// The two layers the resolved allowlist is built from. Both are EMPTY of the
// host under test, so `10.42.0.99` is genuinely un-allowlisted.
jest.mock("@/lib/platform-config-server", () => ({
  getPlatformIdentity: jest.fn(async () => ({ internalHostAllowlist: ["10.25.0.21"] })),
}));
jest.mock("@/lib/nas/store", () => ({
  readStoredNasProviders: jest.fn(async () => []),
  upsertStoredNasProvider: jest.fn(async () => undefined),
  unsuppressEnvProvider: jest.fn(async () => undefined),
  suppressEnvProvider: jest.fn(async () => undefined),
  deleteStoredNasProvider: jest.fn(async () => false),
  deleteNasSmbCreds: jest.fn(async () => undefined),
  writeNasSmbCreds: jest.fn(async () => undefined),
}));

// Route the TCP connection to the loopback test appliance while leaving the URL
// — and therefore the SSRF decision, the SNI logic and the pin check — alone.
const mockAppliance = { port: 0 };
jest.mock("node:https", () => {
  const actual = jest.requireActual<typeof import("node:https")>("node:https");
  return {
    ...actual,
    request: (options: Record<string, unknown>, cb: unknown) =>
      actual.request({ ...options, host: "127.0.0.1", port: mockAppliance.port } as never, cb as never),
  };
});

import { parseAllowedInternalUrlAsync, invalidateInternalHostAllowlist } from "@/lib/internal-url-allowlist-server";
import { fetchNasService, normalizeFingerprint } from "@/lib/nas/pinned-fetch";
import { POST } from "@/app/api/nas/providers/route";
import { upsertStoredNasProvider } from "@/lib/nas/store";

/** A private address that is NOT in DEFAULT_INTERNAL_HOST_ALLOWLIST. */
const FRESH_HOST = "10.42.0.99";
const ADMIN_KEY = "secret-admin-api-key";

let dir: string;
let server: Server;
let fingerprint: string;
/** Requests the appliance actually received — proves what was (not) sent. */
let hits: Array<{ url: string; authorization?: string }>;

type RouteResponse = { status: number; body: Record<string, unknown> };

function request(body: unknown) {
  return { json: async () => body } as never;
}

function postProvider(overrides: Record<string, unknown> = {}) {
  return POST(
    request({
      name: "Attic NAS",
      host: FRESH_HOST,
      kind: "truenas",
      port: 443,
      credentials: { apiKey: ADMIN_KEY },
      ...overrides,
    }),
  ) as unknown as Promise<RouteResponse>;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "nas-wizard-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=truenas"],
    { stdio: "ignore" },
  );
  const printed = execFileSync("openssl", ["x509", "-in", cert, "-noout", "-fingerprint", "-sha256"]).toString();
  fingerprint = normalizeFingerprint(printed.split("=")[1] ?? "");

  hits = [];
  server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    hits.push({ url: req.url ?? "", authorization: req.headers.authorization });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ hostname: "truenas", version: "24.10" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  mockAppliance.port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  hits = [];
  invalidateInternalHostAllowlist();
  jest.clearAllMocks();
});

describe("wizardHost admits one private host without widening the allowlist", () => {
  const url = `https://${FRESH_HOST}:443/api/v2.0/system/info`;

  test("a fresh RFC1918 host is rejected without it — the chicken-and-egg", async () => {
    await expect(parseAllowedInternalUrlAsync(url)).resolves.toBeNull();
  });

  test("threading the wizard's validated host through admits that URL", async () => {
    await expect(parseAllowedInternalUrlAsync(url, { wizardHost: FRESH_HOST })).resolves.not.toBeNull();
  });

  test("a public host is still fail-closed even when passed as wizardHost", async () => {
    const evil = "https://nas.example.com/api/v2.0/system/info";
    await expect(parseAllowedInternalUrlAsync(evil, { wizardHost: "nas.example.com" })).resolves.toBeNull();
  });

  test("a wizardHost that is not the host being dialled is inert", async () => {
    // Private, allowlist-worthy — but not the host in the URL, so it grants nothing.
    await expect(parseAllowedInternalUrlAsync(url, { wizardHost: "10.42.0.98" })).resolves.toBeNull();
  });

  test("ordinary NAS fetches are unchanged: no wizardHost, no access", async () => {
    // Arrange + Act + Assert: the mount/assign paths pass no wizardHost, so an
    // un-stored host must still be refused before a single packet is sent.
    await expect(fetchNasService(url, {}, { pin: fingerprint })).rejects.toThrow("URL not allowed");
    expect(hits).toHaveLength(0);
  });
});

describe("POST /api/nas/providers on a fresh RFC1918 host", () => {
  test("reaches the appliance and answers the 409 certificate challenge", async () => {
    // Act
    const res = await postProvider();

    // Assert: the probe got far enough to see the appliance's certificate.
    expect(res.status).toBe(409);
    expect(res.body.needsCertificateTrust).toBe(true);
    expect(res.body.certificateState).toBe("untrusted");
    const certificate = res.body.certificate as { fingerprint256: string; selfSigned: boolean; subject: string };
    expect(certificate.fingerprint256).toBe(fingerprint);
    expect(certificate.selfSigned).toBe(true);
    expect(certificate.subject).toContain("CN=truenas");

    // The admin API key was never handed to an unverified peer, and nothing
    // was persisted for a provider that has not been trusted yet.
    expect(hits).toHaveLength(0);
    expect(upsertStoredNasProvider).not.toHaveBeenCalled();
  });

  test("stores the provider once the operator confirms that certificate", async () => {
    // Act: the wizard re-submits with the fingerprint it just displayed.
    const res = await postProvider({ tlsFingerprint256: fingerprint });

    // Assert
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: "attic-nas", reachable: true });
    expect(hits).toEqual([{ url: "/api/v2.0/system/info", authorization: `Bearer ${ADMIN_KEY}` }]);
    expect(upsertStoredNasProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: "attic-nas", host: FRESH_HOST, kind: "truenas", tlsFingerprint256: fingerprint }),
    );
  });

  test("a public host never gets as far as the probe", async () => {
    // Act
    const res = await postProvider({ host: "nas.example.com" });

    // Assert
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("is not allowed");
    expect(hits).toHaveLength(0);
  });
});
