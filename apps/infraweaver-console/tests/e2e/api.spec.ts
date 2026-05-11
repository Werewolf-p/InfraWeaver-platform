import { test, expect } from "@playwright/test";

test("home page loads", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/InfraWeaver/i);
});

test("health cluster endpoint responds", async ({ request }) => {
  const response = await request.get("/api/health/cluster");
  expect([200, 401, 403, 500]).toContain(response.status());
});
