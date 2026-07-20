/** @jest-environment node */
// The `?refresh=1` force-renew flag parser shared by the Manage overview + panel
// handlers. Pure over URLSearchParams, so it is asserted directly here.
import { isForceRefresh } from "@/addons/wordpress-manager/lib/manage/refresh";

function params(query: string): URLSearchParams {
  return new URL(`https://console.example/api/wordpress/sites/blog/manage${query}`).searchParams;
}

describe("isForceRefresh", () => {
  test("true for ?refresh=1", () => {
    expect(isForceRefresh(params("?refresh=1"))).toBe(true);
  });

  test("true for ?refresh=true", () => {
    expect(isForceRefresh(params("?refresh=true"))).toBe(true);
  });

  test("false when the flag is absent", () => {
    expect(isForceRefresh(params(""))).toBe(false);
  });

  test("false for other/garbage values (0, yes, empty)", () => {
    expect(isForceRefresh(params("?refresh=0"))).toBe(false);
    expect(isForceRefresh(params("?refresh=yes"))).toBe(false);
    expect(isForceRefresh(params("?refresh="))).toBe(false);
  });

  test("ignores unrelated query params", () => {
    expect(isForceRefresh(params("?foo=1&bar=2"))).toBe(false);
  });
});
