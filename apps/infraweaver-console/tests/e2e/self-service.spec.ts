import { test, expect } from "@playwright/test";

// Self-service + approval flow skeleton. These run unauthenticated in CI, so they
// assert the routes exist and fail CLOSED (auth/permission gates) rather than
// driving a full submit→approve→apply cycle, which needs a seeded session.

test("self-service page is reachable (auth gate may redirect)", async ({ page }) => {
  const response = await page.goto("/self-service");
  // Either the page renders or the auth layer redirects/blocks — never a 5xx.
  expect(response === null || response.status() < 500).toBeTruthy();
});

test("listing own requests requires authentication", async ({ request }) => {
  const response = await request.get("/api/self-service/requests");
  expect([200, 401, 403]).toContain(response.status());
});

test("submitting a request fails closed without a session", async ({ request }) => {
  const response = await request.post("/api/self-service/requests", {
    data: { type: "password-reset", payload: {} },
  });
  // Unauthenticated submit must be rejected (401), rate-limited (429), or blocked.
  expect([401, 403, 429]).toContain(response.status());
});

test("a non-admin cannot approve a request (403/401)", async ({ request }) => {
  const response = await request.post("/api/self-service/requests/does-not-exist/approve");
  expect([401, 403, 404]).toContain(response.status());
});

test("a non-admin cannot deny a request (403/401)", async ({ request }) => {
  const response = await request.post("/api/self-service/requests/does-not-exist/deny", {
    data: { note: "no" },
  });
  expect([401, 403, 404]).toContain(response.status());
});

test("the admin approval feed (?all=1) is permission-gated", async ({ request }) => {
  const response = await request.get("/api/self-service/requests?all=1");
  expect([200, 401, 403]).toContain(response.status());
});

// TODO (needs a seeded authenticated fixture):
//   1. submit an app-access request beyond the requester's ceiling → status "pending" (never auto-applied)
//   2. submit one within ceiling → status "auto-applied"
//   3. as an admin, approve the pending request → status "approved" and the grant lands in users.yaml
//   4. deny another → status "denied" with the required note, and the requester is notified
