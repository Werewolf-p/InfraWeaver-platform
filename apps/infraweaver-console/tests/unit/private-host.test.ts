import { isPrivateHost, isPrivateIpv4, isPrivateIpv6 } from "@/lib/private-host";

describe("isPrivateIpv4", () => {
  it.each([
    "10.0.0.1",
    "10.25.0.21",
    "127.0.0.1",
    "169.254.1.2",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.10",
    "100.64.0.1", // CGNAT
    "198.18.0.1", // benchmarking
  ])("accepts %s", (ip) => expect(isPrivateIpv4(ip)).toBe(true));

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.15.0.1", // just outside 172.16/12
    "172.32.0.1",
    "192.169.0.1",
    "100.63.255.255", // just before CGNAT
    "100.128.0.1", // just after CGNAT
    "256.0.0.1",
    "10.0.0", // shape
    "not.an.ip",
    "",
  ])("rejects %s", (ip) => expect(isPrivateIpv4(ip)).toBe(false));
});

describe("isPrivateIpv6", () => {
  it.each(["::1", "::", "fc00::1", "fd12:3456:789a::1", "fe80::1", "[fe80::1%eth0]"])(
    "accepts %s",
    (ip) => expect(isPrivateIpv6(ip)).toBe(true),
  );
  it.each(["2001:4860:4860::8888", "2606:4700:4700::1111", "8.8.8.8", "not::ip::at::all::really"])(
    "rejects %s",
    (ip) => expect(isPrivateIpv6(ip)).toBe(false),
  );
});

describe("isPrivateHost", () => {
  it("accepts localhost, .local, single-label, private IPs", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("nas.local")).toBe(true);
    expect(isPrivateHost("synology")).toBe(true); // single-label intranet
    expect(isPrivateHost("10.25.0.21")).toBe(true);
    expect(isPrivateHost("fd00::1")).toBe(true);
  });
  it("rejects public multi-label hostnames", () => {
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("nas.example.com")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("")).toBe(false);
  });
});
