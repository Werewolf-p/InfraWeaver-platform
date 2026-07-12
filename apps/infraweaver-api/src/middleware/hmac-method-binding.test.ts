import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { Hono } from "hono";
import { authMiddleware } from "./auth.js";

// Full request binding for the console→API HMAC: the signed message binds
//   `${ts}:${METHOD}:${PATH}:${sha256(body)}:${userId}:${roles}:${clusterId}`
// so a captured signature cannot be replayed under a different method, path, or
// body. PATH is the full Hono c.req.path (`/api/v1/...`, query excluded); the
// console signer (apps/infraweaver-console/src/lib/iw-api.ts) strips the query to
// match. These tests drive the REAL authMiddleware end-to-end.

const SECRET = "test-console-api-secret";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const hmac = (msg: string) => createHmac("sha256", SECRET).update(msg).digest("hex");

// Replicates the console signer's canonicalization exactly.
function signedHeaders(opts: { method: string; path: string; body?: string; userId?: string; roles?: string; clusterId?: string }) {
  const ts = Date.now().toString();
  const userId = opts.userId ?? "koen@example.com";
  const roles = opts.roles ?? "platform-users";
  const clusterId = opts.clusterId ?? "local";
  const bodyHash = sha256(opts.body ?? "");
  const sig = hmac(`${ts}:${opts.method}:${opts.path}:${bodyHash}:${userId}:${roles}:${clusterId}`);
  return {
    "x-console-sig": sig,
    "x-console-ts": ts,
    "x-user-id": userId,
    "x-user-roles": roles,
    "x-cluster-id": clusterId,
    "content-type": "application/json",
  };
}

function makeApp() {
  const api = new Hono();
  api.use("*", authMiddleware);
  api.post("/echo", (c) => c.json({ ok: true }));
  api.get("/ping", (c) => c.json({ ok: true }));
  const app = new Hono();
  app.route("/api/v1", api);
  return app;
}

describe("console→API HMAC full request binding (integration)", () => {
  let app: Hono;
  before(() => { process.env.CONSOLE_API_SECRET = SECRET; app = makeApp(); });
  after(() => { delete process.env.CONSOLE_API_SECRET; });

  it("accepts a correctly-signed POST (method+path+body all match)", async () => {
    const body = JSON.stringify({ hello: "world" });
    const res = await app.request("/api/v1/echo", {
      method: "POST", body, headers: signedHeaders({ method: "POST", path: "/api/v1/echo", body }),
    });
    assert.equal(res.status, 200);
  });

  it("rejects when the BODY is tampered after signing (401)", async () => {
    const signedBody = JSON.stringify({ hello: "world" });
    const headers = signedHeaders({ method: "POST", path: "/api/v1/echo", body: signedBody });
    const res = await app.request("/api/v1/echo", {
      method: "POST", body: JSON.stringify({ hello: "evil" }), headers,
    });
    assert.equal(res.status, 401);
  });

  it("rejects when the signature was made for a different PATH (401)", async () => {
    const body = JSON.stringify({ hello: "world" });
    const headers = signedHeaders({ method: "POST", path: "/api/v1/other", body });
    const res = await app.request("/api/v1/echo", { method: "POST", body, headers });
    assert.equal(res.status, 401);
  });

  it("rejects when a GET signature is replayed as a POST (method binding, 401)", async () => {
    const headers = signedHeaders({ method: "GET", path: "/api/v1/echo", body: "" });
    const res = await app.request("/api/v1/echo", {
      method: "POST", body: JSON.stringify({}), headers,
    });
    assert.equal(res.status, 401);
  });

  it("accepts a correctly-signed GET with empty body", async () => {
    const res = await app.request("/api/v1/ping", {
      method: "GET", headers: signedHeaders({ method: "GET", path: "/api/v1/ping", body: "" }),
    });
    assert.equal(res.status, 200);
  });
});
