import { isCgnatIp } from "@/lib/udm/cgnat";

describe("isCgnatIp", () => {
  it("returns true for addresses inside 100.64.0.0/10", () => {
    expect(isCgnatIp("100.64.0.0")).toBe(true);
    expect(isCgnatIp("100.72.13.4")).toBe(true);
    expect(isCgnatIp("100.127.255.255")).toBe(true);
  });

  it("returns false for addresses just outside the range", () => {
    expect(isCgnatIp("100.63.255.255")).toBe(false);
    expect(isCgnatIp("100.128.0.0")).toBe(false);
    expect(isCgnatIp("99.64.0.0")).toBe(false);
  });

  it("returns false for ordinary public and private addresses", () => {
    expect(isCgnatIp("84.82.69.110")).toBe(false);
    expect(isCgnatIp("10.10.0.1")).toBe(false);
    expect(isCgnatIp("192.168.1.1")).toBe(false);
  });

  it("returns false for malformed input", () => {
    expect(isCgnatIp("")).toBe(false);
    expect(isCgnatIp("100.64.0")).toBe(false);
    expect(isCgnatIp("100.64.0.256")).toBe(false);
    expect(isCgnatIp("100.abc.0.1")).toBe(false);
  });
});
