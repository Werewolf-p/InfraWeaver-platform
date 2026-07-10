/**
 * @jest-environment node
 */
// Found by driving a real, freshly-wiped Jellyfin 10.11.11.
//
// `POST /Startup/User` does not CREATE the wizard's first user — it renames the
// one Jellyfin makes for itself and sets its password. Jellyfin creates that user
// asynchronously, a moment after the HTTP listener is up, and answers 404 until it
// exists. A console reconcile that races a freshly-started server therefore aborted
// the bootstrap; the retry then found the wizard complete-but-uncredentialed and
// demanded a JELLYFIN_BOOTSTRAP_TOKEN that should never have been needed.
//
// The startup controller also answers 404 for a missing password, so the status
// alone cannot distinguish the two cases. We wait for GET /Startup/User instead.

jest.mock("server-only", () => ({}), { virtual: true });

import { JellyfinClient } from "@/lib/jellyfin/client";

const BASE = "http://jellyfin.test:8096";

interface Call { method: string; path: string; body?: unknown }

/** A fake Jellyfin whose startup user only appears after `readyAfter` GETs. */
function fakeJellyfin(readyAfter: number) {
  const calls: Call[] = [];
  let getStartupUserCount = 0;

  const fetchMock = jest.fn(async (url: string | URL, init?: RequestInit) => {
    const path = String(url).slice(BASE.length);
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    if (method === "GET" && path === "/Startup/User") {
      getStartupUserCount += 1;
      if (getStartupUserCount <= readyAfter) {
        return new Response('"not found"', { status: 404 });
      }
      return new Response(JSON.stringify({ Name: "abc" }), { status: 200 });
    }
    if (method === "POST" && path === "/Startup/User") {
      // Refuse if the default user has not appeared — exactly what Jellyfin does.
      if (getStartupUserCount <= readyAfter) return new Response('"not found"', { status: 404 });
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path === "/Startup/Complete") return new Response(null, { status: 204 });
    return new Response("unexpected", { status: 500 });
  });

  return { calls, fetchMock, startupUserGets: () => getStartupUserCount };
}

describe("completeStartup waits for Jellyfin's startup user", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; jest.useRealTimers(); });

  it("does not POST /Startup/User before the default user exists", async () => {
    const fake = fakeJellyfin(0); // ready immediately
    globalThis.fetch = fake.fetchMock as unknown as typeof fetch;

    await new JellyfinClient(BASE).completeStartup("infraweaver-service", "s3cr3t-password-x");

    const order = fake.calls.map((c) => `${c.method} ${c.path}`);
    expect(order).toEqual([
      "GET /Startup/User",
      "POST /Startup/User",
      "POST /Startup/Complete",
    ]);
  });

  it("polls until the startup user appears, then completes", async () => {
    const fake = fakeJellyfin(2); // 404 for the first two GETs
    globalThis.fetch = fake.fetchMock as unknown as typeof fetch;

    await new JellyfinClient(BASE).completeStartup("infraweaver-service", "s3cr3t-password-x");

    expect(fake.startupUserGets()).toBe(3);
    const posts = fake.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => c.path)).toEqual(["/Startup/User", "/Startup/Complete"]);
  }, 15_000);

  it("sends the password — an omitted one is what Jellyfin reports as 404", async () => {
    const fake = fakeJellyfin(0);
    globalThis.fetch = fake.fetchMock as unknown as typeof fetch;

    await new JellyfinClient(BASE).completeStartup("infraweaver-service", "s3cr3t-password-x");

    const post = fake.calls.find((c) => c.method === "POST" && c.path === "/Startup/User")!;
    expect(post.body).toEqual({ Name: "infraweaver-service", Password: "s3cr3t-password-x" });
  });

  it("gives up with an actionable error if the startup user never appears", async () => {
    process.env.JELLYFIN_STARTUP_TIMEOUT_MS = "1500";
    jest.resetModules();
    const { JellyfinClient: Fresh } = await import("@/lib/jellyfin/client");

    const fake = fakeJellyfin(Number.POSITIVE_INFINITY);
    globalThis.fetch = fake.fetchMock as unknown as typeof fetch;

    await expect(new Fresh(BASE).completeStartup("svc", "pw-long-enough-x")).rejects.toThrow(/did not create its startup user/);
    expect(fake.calls.some((c) => c.method === "POST")).toBe(false);
    delete process.env.JELLYFIN_STARTUP_TIMEOUT_MS;
  }, 15_000);
});
