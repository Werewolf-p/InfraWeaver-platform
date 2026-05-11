import { test, expect } from "@playwright/test";

test("health endpoint returns ok", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
});

test("health endpoint returns JSON with status", async ({ request }) => {
  const response = await request.get("/api/health");
  const body = await response.json();
  expect(body).toHaveProperty("status");
});
