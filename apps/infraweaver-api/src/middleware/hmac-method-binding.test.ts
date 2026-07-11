import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { signHmac, verifyHmac } from "../lib/hmac.js";

// Contract test for the console→API HMAC method binding. The console signer
// (apps/infraweaver-console/src/lib/iw-api.ts) and the API verifier
// (middleware/auth.ts) must agree on the signed message shape:
//   `${ts}:${METHOD}:${userId}:${roles}:${clusterId}`
// Binding the method means a captured signature cannot be replayed under a
// different HTTP method (e.g. a GET's headers reused to issue a mutation).

const SECRET = "test-console-api-secret";
const ts = "1783900000000";
const userId = "koen@example.com";
const roles = "platform-users,game-hub:read";
const clusterId = "local";

const message = (method: string) => `${ts}:${method}:${userId}:${roles}:${clusterId}`;

describe("console→API HMAC method binding", () => {
  it("verifies a signature under the SAME method it was signed for", () => {
    const sig = signHmac(message("POST"), SECRET);
    assert.equal(verifyHmac(message("POST"), sig, SECRET), true);
  });

  it("REJECTS a signature replayed under a different method (GET sig → POST)", () => {
    const getSig = signHmac(message("GET"), SECRET);
    assert.equal(verifyHmac(message("POST"), getSig, SECRET), false);
    assert.equal(verifyHmac(message("DELETE"), getSig, SECRET), false);
  });

  it("still rejects a wrong secret", () => {
    const sig = signHmac(message("PUT"), SECRET);
    assert.equal(verifyHmac(message("PUT"), sig, "other-secret"), false);
  });
});
