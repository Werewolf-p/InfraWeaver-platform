/**
 * @jest-environment node
 */
// next/server (imported transitively by iw-api) needs the Web `Request` global,
// which jsdom omits; the node env provides Request/Response/Headers/fetch.
import { createHash, createHmac } from "node:crypto";

// iwApiFetch pulls in the proxy-route factory (route-utils -> NextAuth/session
// wiring) and, transitively, the ESM-only k8s client. Neither is exercised by
// the signing path, so stub them out to keep the test hermetic.
jest.mock("@kubernetes/client-node", () => ({}));
jest.mock("@/lib/route-utils", () => ({ withRoute: () => async () => undefined }));

import { iwApiFetch } from "@/lib/iw-api";

const SECRET = "unit-test-console-secret";

function hmac(message: string): string {
  return createHmac("sha256", SECRET).update(message).digest("hex");
}

/**
 * The infraweaver-api verifier rebuilds the signed string from the RECEIVED
 * headers (middleware/auth.ts:81). The console's job is to sign exactly what it
 * transmits, so the sig it sends must equal an HMAC recomputed over the header
 * values as they arrive — even after the Headers layer normalizes them. This was
 * broken when the console signed the raw session strings instead: an SSO group
 * name with surrounding whitespace got trimmed on the wire, so signed != received
 * and every poll 401'd with "Invalid signature".
 */
describe("iwApiFetch — signs exactly what it transmits", () => {
  const realFetch = global.fetch;
  let captured: Headers | null = null;

  beforeEach(() => {
    process.env.CONSOLE_API_SECRET = SECRET;
    process.env.INFRAWEAVER_API_URL = "http://api.test";
    captured = null;
    global.fetch = jest.fn(async (_url: unknown, init: RequestInit) => {
      captured = init.headers as Headers;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  function recomputeFromReceived(method: string, signedPath: string): string {
    const h = captured as Headers;
    const message = [
      h.get("x-console-ts") ?? "",
      method,
      signedPath,
      createHash("sha256").update("").digest("hex"),
      h.get("x-user-id") ?? "",
      h.get("x-user-roles") ?? "",
      h.get("x-cluster-id") ?? "",
    ].join(":");
    return hmac(message);
  }

  it("verifies against received headers when a group name carries trailing whitespace", async () => {
    const session = { user: { email: "e2e@example.com", groups: ["platform-admins "] } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await iwApiFetch("/k8s/pods", session as any, "prod");

    expect(captured).not.toBeNull();
    // Confirm the Headers layer really trimmed the value in transit — the
    // precondition for the original bug.
    expect((captured as Headers).get("x-user-roles")).toBe("platform-admins");
    // The sent signature must verify against those trimmed, transmitted bytes.
    expect((captured as Headers).get("x-console-sig")).toBe(
      recomputeFromReceived("GET", "/api/v1/k8s/pods"),
    );
  });

  it("verifies for a clean superuser-style identity (no groups) too", async () => {
    const session = { user: { email: "remon@example.com", groups: [] } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await iwApiFetch("/k8s/pods", session as any, "local");

    expect((captured as Headers).get("x-console-sig")).toBe(
      recomputeFromReceived("GET", "/api/v1/k8s/pods"),
    );
  });

  it("strips the query string from the signed path (matches verifier c.req.path)", async () => {
    const session = { user: { email: "e2e@example.com", groups: ["viewers"] } };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await iwApiFetch("/k8s/pods?namespace=game-hub", session as any, "prod");

    expect((captured as Headers).get("x-console-sig")).toBe(
      recomputeFromReceived("GET", "/api/v1/k8s/pods"),
    );
  });
});
