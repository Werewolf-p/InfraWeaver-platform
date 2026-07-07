/**
 * Session-reuse + 401 re-login behavior of the cert-pinned node:https transport.
 *
 * `node:https` is mocked with an EventEmitter fake: `request()` never emits a
 * `socket`, so the cert-pin `secureConnect` handler never runs (no real TLS is
 * needed), and each call resolves to a scripted response. Tests assert how many
 * times `/api/auth/login` is hit — the whole point of the module-level cookie
 * jar is that a burst, and per-request transport rebuilds, log in exactly once.
 */

import { EventEmitter } from "node:events";

interface MockResp {
  status: number;
  headers: Record<string, unknown>;
  body: string;
}

// `mock`-prefixed so jest permits referencing them from the hoisted factory.
const mockCalls: Array<{ method: string; path: string }> = [];
let mockRespond: (method: string, path: string) => MockResp;

jest.mock("node:https", () => {
  const request = (
    opts: { method: string; path: string },
    cb: (res: EventEmitter & { statusCode: number; headers: Record<string, unknown> }) => void,
  ) => {
    const req = new EventEmitter() as EventEmitter & {
      write: () => void;
      end: () => void;
      destroy: (err?: Error) => void;
    };
    req.write = () => {};
    req.destroy = (err?: Error) => {
      if (err) req.emit("error", err);
    };
    req.end = () => {
      // Defer so the caller's res.on("data"/"end") listeners attach first.
      void Promise.resolve().then(() => {
        mockCalls.push({ method: opts.method, path: opts.path });
        const scripted = mockRespond(opts.method, opts.path);
        const res = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, unknown>;
        };
        res.statusCode = scripted.status;
        res.headers = scripted.headers;
        cb(res);
        res.emit("data", Buffer.from(scripted.body));
        res.emit("end");
      });
    };
    return req;
  };
  const mockHttps = { Agent: class {}, request };
  // Expose under both `default` and namespace so the import shape is irrelevant.
  return { __esModule: true, default: mockHttps, ...mockHttps };
});

import { createHttpsTransport, __clearUdmSessionsForTest } from "@/lib/udm/https-transport";
import type { UdmConfig } from "@/lib/udm/types";

const CONFIG: UdmConfig = {
  host: "https://10.10.0.1",
  username: "apiuser",
  password: "pw",
  fingerprintSha256: "aa",
  site: "default",
};

const DATA_PATH = "/proxy/network/api/s/default/rest/portforward";

/** Count of `/api/auth/login` POSTs recorded so far. */
function loginCount(): number {
  return mockCalls.filter((c) => c.method === "POST" && c.path === "/api/auth/login").length;
}

/** Default script: prime GET / and login both mint a fresh cookie; data is 200. */
function scriptHealthy(): (method: string, path: string) => MockResp {
  let logins = 0;
  return (_method, path) => {
    if (path === "/") {
      return { status: 200, headers: { "set-cookie": ["TOKEN=prime; Path=/"], "x-csrf-token": "csrf-prime" }, body: "" };
    }
    if (path === "/api/auth/login") {
      logins += 1;
      return {
        status: 200,
        headers: { "set-cookie": [`TOKEN=session-${logins}; Path=/`], "x-csrf-token": `csrf-${logins}` },
        body: JSON.stringify({ meta: { rc: "ok" } }),
      };
    }
    return { status: 200, headers: {}, body: JSON.stringify({ data: [] }) };
  };
}

beforeEach(() => {
  mockCalls.length = 0;
  __clearUdmSessionsForTest();
  mockRespond = scriptHealthy();
});

describe("createHttpsTransport session reuse", () => {
  it("logs in once and reuses the session across many requests", async () => {
    const transport = createHttpsTransport(CONFIG);

    await transport("GET", DATA_PATH);
    await transport("GET", DATA_PATH);
    await transport("GET", DATA_PATH);

    expect(loginCount()).toBe(1);
    // Three data reads, one prime, one login — login endpoints hit exactly once.
    expect(mockCalls.filter((c) => c.path === DATA_PATH)).toHaveLength(3);
    expect(mockCalls.filter((c) => c.path === "/")).toHaveLength(1);
  });

  it("shares the session across separate transports for the same gateway+user", async () => {
    // Simulates getUdmClientAsync() rebuilding a fresh transport per request.
    await createHttpsTransport(CONFIG)("GET", DATA_PATH);
    expect(loginCount()).toBe(1);

    await createHttpsTransport(CONFIG)("GET", DATA_PATH);
    await createHttpsTransport(CONFIG)("GET", DATA_PATH);

    // No second login — the module-level cookie jar is reused.
    expect(loginCount()).toBe(1);
  });

  it("collapses a concurrent burst into a single login", async () => {
    // Five per-request transports fire at once on a cold jar — the historical
    // shape that stampeded /api/auth/login into a 429.
    const transports = Array.from({ length: 5 }, () => createHttpsTransport(CONFIG));
    await Promise.all(transports.map((t) => t("GET", DATA_PATH)));

    expect(loginCount()).toBe(1);
  });

  it("keeps a separate session per distinct gateway+user", async () => {
    await createHttpsTransport(CONFIG)("GET", DATA_PATH);
    await createHttpsTransport({ ...CONFIG, host: "https://10.25.0.1" })("GET", DATA_PATH);

    // Two different hosts → two independent logins.
    expect(loginCount()).toBe(2);
  });
});

describe("createHttpsTransport 401 re-login", () => {
  it("re-authenticates once and retries when a request returns 401", async () => {
    let logins = 0;
    let dataHits = 0;
    mockRespond = (_method, path) => {
      if (path === "/") {
        return { status: 200, headers: { "set-cookie": ["TOKEN=prime; Path=/"], "x-csrf-token": "csrf-prime" }, body: "" };
      }
      if (path === "/api/auth/login") {
        logins += 1;
        return {
          status: 200,
          headers: { "set-cookie": [`TOKEN=session-${logins}; Path=/`], "x-csrf-token": `csrf-${logins}` },
          body: "",
        };
      }
      dataHits += 1;
      // First data read hits an expired session; the retry succeeds.
      if (dataHits === 1) return { status: 401, headers: {}, body: "" };
      return { status: 200, headers: {}, body: JSON.stringify({ data: ["ok"] }) };
    };

    const transport = createHttpsTransport(CONFIG);
    const res = await transport("GET", DATA_PATH);

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ data: ["ok"] });
    // Initial login + one re-login after the 401.
    expect(loginCount()).toBe(2);
    expect(mockCalls.filter((c) => c.path === DATA_PATH)).toHaveLength(2);
  });

  it("re-logins only once, not on every subsequent call, after recovering", async () => {
    let logins = 0;
    let dataHits = 0;
    mockRespond = (_method, path) => {
      if (path === "/") {
        return { status: 200, headers: { "set-cookie": ["TOKEN=prime; Path=/"], "x-csrf-token": "csrf-prime" }, body: "" };
      }
      if (path === "/api/auth/login") {
        logins += 1;
        return { status: 200, headers: { "set-cookie": [`TOKEN=session-${logins}; Path=/`] }, body: "" };
      }
      dataHits += 1;
      if (dataHits === 1) return { status: 401, headers: {}, body: "" };
      return { status: 200, headers: {}, body: JSON.stringify({ data: [] }) };
    };

    const transport = createHttpsTransport(CONFIG);
    await transport("GET", DATA_PATH); // 401 then recover → 2 logins
    await transport("GET", DATA_PATH); // reuses recovered session
    await transport("GET", DATA_PATH);

    expect(loginCount()).toBe(2);
  });
});
