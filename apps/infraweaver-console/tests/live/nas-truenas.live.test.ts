/**
 * @jest-environment node
 *
 * LIVE test against a real TrueNAS appliance. Not picked up by `npm test`
 * (jest.config testMatch only globs tests/unit). Run explicitly:
 *
 *   NAS_LIVE_HOST=<nas-ip> npx jest --testMatch='**\/tests/live/**\/*.test.ts'
 *
 * It sends no credentials: it proves the TLS pin gate and the corrected
 * `/api/v2.0` base path against the appliance's real certificate.
 */

import { probeNasCredentials } from "@/lib/nas/discovery";
import {
  NasCertificateMismatchError,
  NasCertificateUntrustedError,
  fetchNasService,
} from "@/lib/nas/pinned-fetch";

jest.mock("@/lib/internal-url-allowlist-server", () => ({
  parseAllowedInternalUrlAsync: jest.fn(async (raw: string) => new URL(raw)),
}));

// No default host: this repo is mirrored to a public template, so the
// appliance address must come from the environment.
const HOST = process.env.NAS_LIVE_HOST;
const PORT = Number(process.env.NAS_LIVE_PORT ?? 443);
if (!HOST) throw new Error("NAS_LIVE_HOST is required to run the live NAS test");
const WRONG_PIN = "A".repeat(64);

jest.setTimeout(20_000);

describe(`live TrueNAS at ${HOST}:${PORT}`, () => {
  let fingerprint: string;

  test("an unpinned call is refused and surfaces the appliance certificate", async () => {
    const error = await fetchNasService(`https://${HOST}:${PORT}/api/v2.0/system/info`)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NasCertificateUntrustedError);
    const untrusted = error as NasCertificateUntrustedError;
    expect(untrusted.certificate.selfSigned).toBe(true);
    expect(untrusted.certificate.fingerprint256).toMatch(/^[0-9A-F]{64}$/);
    fingerprint = untrusted.certificate.fingerprint256;
  });

  test("a wrong pin fails closed", async () => {
    const error = await fetchNasService(`https://${HOST}:${PORT}/api/v2.0/system/info`, {}, { pin: WRONG_PIN })
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NasCertificateMismatchError);
  });

  test("the correct pin reaches the API, and /api/v2.0 is the live base path", async () => {
    // 401 (not 404) proves the path exists and only auth is missing.
    const res = await fetchNasService(`https://${HOST}:${PORT}/api/v2.0/system/info`, {}, { pin: fingerprint });
    expect(res.status).toBe(401);

    // The old path the code used must still be a 404, i.e. we really did fix a bug.
    const stale = await fetchNasService(`https://${HOST}:${PORT}/api/v2/system/info`, {}, { pin: fingerprint });
    expect(stale.status).toBe(404);
  });

  test("probeNasCredentials reports an untrusted certificate instead of `fetch failed`", async () => {
    const probe = await probeNasCredentials(
      { host: HOST, port: PORT, kind: "truenas" },
      { apiKey: "not-a-real-key" },
    );

    expect(probe.ok).toBe(false);
    expect(probe.certificateState).toBe("untrusted");
    expect(probe.certificate?.fingerprint256).toBe(fingerprint);
    expect(probe.error).toContain("not trusted yet");
  });

  test("once pinned, a bad key is reported as a rejected key, not a transport error", async () => {
    const probe = await probeNasCredentials(
      { host: HOST, port: PORT, kind: "truenas", tlsFingerprint256: fingerprint },
      { apiKey: "not-a-real-key" },
    );

    expect(probe.ok).toBe(false);
    expect(probe.certificateState).toBeUndefined();
    expect(probe.error).toBe("TrueNAS rejected the API key (HTTP 401)");
  });
});
