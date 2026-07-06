import { accessFieldsFromRequest, logMutatingAccess } from "@/lib/access-log";

function makeReq(method: string, url: string, headers: Record<string, string> = {}): Request {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method,
    url,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
  } as unknown as Request;
}

describe("accessFieldsFromRequest", () => {
  it("extracts method, path, actor, ip, referer and user-agent", () => {
    const req = makeReq("POST", "https://console.int/api/pods/bulk-restart?clusterId=local", {
      "x-forwarded-for": "10.0.0.5, 10.0.0.1",
      referer: "https://console.int/apps",
      "user-agent": "Mozilla/5.0",
    });

    const fields = accessFieldsFromRequest(req, "remon@example.com", { clusterId: "local", status: 200 });

    expect(fields).toMatchObject({
      method: "POST",
      path: "/api/pods/bulk-restart",
      actor: "remon@example.com",
      ip: "10.0.0.5",
      referer: "https://console.int/apps",
      userAgent: "Mozilla/5.0",
      clusterId: "local",
      status: 200,
    });
  });

  it("falls back to 'unknown' when actor is empty", () => {
    expect(accessFieldsFromRequest(makeReq("DELETE", "https://x/api/pods/ns/name"), "").actor).toBe("unknown");
  });

  it("prefers x-real-ip over x-forwarded-for", () => {
    const req = makeReq("POST", "https://x/api/pods/restart", { "x-real-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" });
    expect(accessFieldsFromRequest(req, "a").ip).toBe("1.2.3.4");
  });
});

describe("logMutatingAccess", () => {
  const original = console.log;
  let lines: string[];

  beforeEach(() => {
    lines = [];
    console.log = (msg?: unknown) => { lines.push(String(msg)); };
  });
  afterEach(() => {
    console.log = original;
  });

  it("emits a type:access line for mutating methods", () => {
    logMutatingAccess(makeReq("DELETE", "https://x/api/pods/game-hub/ark-0"), "remon@example.com", { status: 200 });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({ type: "access", method: "DELETE", path: "/api/pods/game-hub/ark-0", actor: "remon@example.com", status: 200 });
  });

  it("does not log read-only methods", () => {
    logMutatingAccess(makeReq("GET", "https://x/api/pods"), "remon@example.com");
    expect(lines).toHaveLength(0);
  });
});
