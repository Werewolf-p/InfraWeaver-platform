import { redactAuditDetail } from "@/lib/audit-log";

describe("audit log redaction", () => {
  it("redacts bearer tokens and secrets", () => {
    const result = redactAuditDetail(
      'authorization: Bearer super-secret-token password=hunter2 {"token":"abc123","secret":"xyz"}',
    );

    expect(result).toContain("authorization: Bearer [redacted]");
    expect(result).toContain("password=[redacted]");
    expect(result).toContain('"token":"[redacted]"');
    expect(result).toContain('"secret":"[redacted]"');
  });

  it("redacts jwt-like values", () => {
    const result = redactAuditDetail("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature");

    expect(result).toContain("[redacted-jwt]");
  });
});
