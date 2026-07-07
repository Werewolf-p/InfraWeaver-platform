import { isValidRuleName, validatePortForwardRule } from "@/lib/udm/validate";

const GOOD = {
  name: "palworld",
  enabled: true,
  proto: "udp",
  dst_port: "8211",
  fwd: "10.10.0.91",
  fwd_port: "32255",
};

describe("validatePortForwardRule", () => {
  it("accepts and normalizes a well-formed rule", () => {
    const result = validatePortForwardRule(GOOD);
    expect(result.ok).toBe(true);
    expect(result.rule).toMatchObject({ name: "palworld", proto: "udp", src: "any", log: false });
  });

  it("defaults enabled to true and src to 'any'", () => {
    const result = validatePortForwardRule({ ...GOOD, enabled: undefined, src: undefined });
    expect(result.rule?.enabled).toBe(true);
    expect(result.rule?.src).toBe("any");
  });

  it("rejects a non-object body", () => {
    expect(validatePortForwardRule(null).ok).toBe(false);
    expect(validatePortForwardRule("nope").ok).toBe(false);
  });

  it("rejects an invalid protocol", () => {
    expect(validatePortForwardRule({ ...GOOD, proto: "icmp" }).error).toMatch(/proto/);
  });

  it("rejects out-of-range and non-numeric ports", () => {
    expect(validatePortForwardRule({ ...GOOD, dst_port: "70000" }).ok).toBe(false);
    expect(validatePortForwardRule({ ...GOOD, dst_port: "0" }).ok).toBe(false);
    expect(validatePortForwardRule({ ...GOOD, fwd_port: "abc" }).ok).toBe(false);
  });

  it("rejects a non-IPv4 forward target", () => {
    expect(validatePortForwardRule({ ...GOOD, fwd: "10.10.0.999" }).ok).toBe(false);
    expect(validatePortForwardRule({ ...GOOD, fwd: "example.com" }).ok).toBe(false);
  });

  it("rejects a name with unsafe characters", () => {
    expect(validatePortForwardRule({ ...GOOD, name: "../etc" }).ok).toBe(false);
    expect(validatePortForwardRule({ ...GOOD, name: "" }).ok).toBe(false);
  });
});

describe("isValidRuleName", () => {
  it("accepts a normal name and rejects unsafe or non-string input", () => {
    expect(isValidRuleName("palworld")).toBe(true);
    expect(isValidRuleName("bad/name")).toBe(false);
    expect(isValidRuleName(42)).toBe(false);
  });
});
