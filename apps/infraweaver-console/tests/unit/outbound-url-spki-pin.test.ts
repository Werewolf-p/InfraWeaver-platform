/** @jest-environment node */
// Cert backbone — the SPKI pin helper must produce the exact `sha256//` pin
// value that `openssl x509 -pubkey | openssl pkey -pubin -outform der |
// openssl dgst -sha256 -binary | base64` produces, so a pin we capture matches
// what any standard tool (or the site operator) would compute independently.
jest.mock("server-only", () => ({}), { virtual: true });

import { spkiSha256Pin } from "@/lib/outbound-url";

// Throwaway P-256 self-signed cert (TEST VECTOR ONLY) and the standard SPKI pin
// computed for it by the openssl pipeline above.
const TEST_CERT_DER_B64 =
  "MIIBhzCCAS2gAwIBAgIUMZwWtNddOuDp9aa9fAR0fXEVbUEwCgYIKoZIzj0EAwIwGTEXMBUGA1UEAwwOcGluLnRlc3QubG9jYWwwHhcNMjYwNzE3MTkyMTIwWhcNMzYwNzE0MTkyMTIwWjAZMRcwFQYDVQQDDA5waW4udGVzdC5sb2NhbDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABDS05dJafn7y4Xc2TuvK9eO1dO6szlziqXtunuuOE25Xnb6LAbLnFo2ZXtOQEyNICpC8LPHeh4ElKc+5dffGVRSjUzBRMB0GA1UdDgQWBBRgmCyeTI6bLKaqb2yjkYy7XOlrRzAfBgNVHSMEGDAWgBRgmCyeTI6bLKaqb2yjkYy7XOlrRzAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIQDM5wBSm4bcDxL3mkx/RaljbahFkbzziYown2IrBQGBWgIgOc3PEyjw+VgKhwn35VhJ3Mp4KiK4EMwF991c4DwGAto=";
const EXPECTED_PIN = "bUTZU12XAo8bT0HY6aIlqtckw98hCEM4T8MgKg0Qx7w=";

describe("spkiSha256Pin", () => {
  const der = Buffer.from(TEST_CERT_DER_B64, "base64");

  test("matches the standard openssl-derived SPKI pin for the cert", () => {
    expect(spkiSha256Pin(der)).toBe(EXPECTED_PIN);
  });

  test("is deterministic for the same certificate", () => {
    expect(spkiSha256Pin(der)).toBe(spkiSha256Pin(der));
  });

  test("throws on bytes that are not a certificate (so garbage never silently matches a pin)", () => {
    expect(() => spkiSha256Pin(Buffer.from("not a certificate"))).toThrow();
  });
});
