import { ensureSsoGate, removeSsoGate } from "@/lib/sso/sso-gate";
import type { SecretStore } from "@/lib/sso/types";

/**
 * Live-shape Authentik API fakery. The router answers the GET lookups the SSO gate
 * makes (flows, cert, scope mappings, outpost, provider/app search) and records
 * every mutating call so a test can assert create-vs-patch, exact hosts, outpost
 * union and teardown without a real Authentik.
 */
interface ApiState {
  oauthProviders: { pk: number; name: string }[];
  proxyProviders: { pk: number; name: string }[];
  applications: { pk: string; slug: string }[];
  outpostProviders: number[];
  nextPk: number;
}

interface RecordedCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

function makeFetch(state: ApiState) {
  const calls: RecordedCall[] = [];
  const json = (data: unknown, status = 200) =>
    Promise.resolve({ ok: status < 400, status, json: async () => data } as Response);

  const fetchMock = jest.fn((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace("http://authentik.test", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    if (method !== "GET") calls.push({ method, path, body });

    // --- GET lookups ---
    if (path.startsWith("/api/v3/flows/instances/")) {
      const slug = new URL(url).searchParams.get("slug")!;
      return json({ results: [{ pk: `flow-${slug}`, slug }] });
    }
    if (path.startsWith("/api/v3/crypto/certificatekeypairs/")) {
      return json({ results: [{ pk: "cert-1", name: "authentik Self-signed Certificate" }] });
    }
    if (path.startsWith("/api/v3/propertymappings/provider/scope/")) {
      return json({
        results: [
          { pk: "m-openid", scope_name: "openid" },
          { pk: "m-email", scope_name: "email" },
          { pk: "m-profile", scope_name: "profile" },
          { pk: "m-akproxy", scope_name: "ak_proxy" },
        ],
      });
    }
    if (path.startsWith("/api/v3/outposts/instances/") && method === "GET") {
      return json({ results: [{ pk: "op-1", name: "authentik Embedded Outpost", type: "proxy", managed: "goauthentik.io/outposts/embedded", providers: state.outpostProviders }] });
    }
    if (path.startsWith("/api/v3/outposts/instances/") && method === "PATCH") {
      state.outpostProviders = body!.providers as number[];
      return json({});
    }
    if (path.startsWith("/api/v3/providers/oauth2/") && method === "GET") {
      return json({ results: state.oauthProviders });
    }
    if (path.startsWith("/api/v3/providers/proxy/") && method === "GET") {
      return json({ results: state.proxyProviders });
    }
    if (path.startsWith("/api/v3/core/applications/?search=") && method === "GET") {
      // Mirror Authentik's fuzzy search: substring match, caller picks exact slug.
      const q = new URL(url).searchParams.get("search")!;
      return json({ results: state.applications.filter((a) => a.slug.includes(q)) });
    }

    // --- mutations ---
    if (path === "/api/v3/providers/oauth2/" && method === "POST") return json({ pk: state.nextPk++ });
    if (path === "/api/v3/providers/proxy/" && method === "POST") return json({ pk: state.nextPk++ });
    if (path === "/api/v3/core/applications/" && method === "POST") return json({ pk: "app-new" });
    if (method === "PATCH" || method === "DELETE") return json({});
    throw new Error(`unrouted ${method} ${path}`);
  });

  return { fetchMock, calls };
}

function emptyState(): ApiState {
  return { oauthProviders: [], proxyProviders: [], applications: [], outpostProviders: [1, 2, 3], nextPk: 100 };
}

function memoryStore(seed?: Record<string, string>): SecretStore & { written: Record<string, Record<string, string>> } {
  const written: Record<string, Record<string, string>> = {};
  return {
    written,
    read: async (path: string) => (path in written ? written[path] : seed ?? null),
    write: async (path: string, data: Record<string, string>) => {
      written[path] = data;
    },
  };
}

const baseInput = {
  host: "blog.example.com",
  appSlug: "wordpress-blog",
  appName: "WordPress — blog",
  redirectUris: ["https://blog.example.com/wp-admin/admin-ajax.php?action=openid-connect-authorize"],
  launchUrl: "https://blog.example.com/wp-admin/",
  secretPath: "secret/wordpress/blog/authentik",
  issuerBase: "https://auth.example.com",
} as const;

beforeEach(() => {
  process.env.AUTHENTIK_URL = "http://authentik.test";
  process.env.AUTHENTIK_TOKEN = "test-token";
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("ensureSsoGate — create path (mode both)", () => {
  test("POSTs both providers with exact host/redirect, mints a 48-char secret, unions the outpost", async () => {
    const state = emptyState();
    const { fetchMock, calls } = makeFetch(state);
    global.fetch = fetchMock as unknown as typeof fetch;
    const store = memoryStore();

    const result = await ensureSsoGate({ ...baseInput, mode: "both" }, store);

    const oauthPost = calls.find((c) => c.path === "/api/v3/providers/oauth2/" && c.method === "POST")!;
    expect(oauthPost.body!.client_type).toBe("confidential");
    expect(oauthPost.body!.redirect_uris).toEqual([
      { matching_mode: "strict", url: baseInput.redirectUris[0], redirect_uri_type: "authorization" },
    ]);
    expect(oauthPost.body!.signing_key).toBe("cert-1");

    const proxyPost = calls.find((c) => c.path === "/api/v3/providers/proxy/" && c.method === "POST")!;
    expect(proxyPost.body!.mode).toBe("forward_single");
    expect(proxyPost.body!.external_host).toBe("https://blog.example.com");

    // Two applications: the OIDC consumer app (oauth2 primary) and a separate gate
    // app (proxy primary) — the outpost only serves a proxy that is an app's primary.
    const appPosts = calls.filter((c) => c.path === "/api/v3/core/applications/" && c.method === "POST");
    expect(appPosts).toHaveLength(2);
    expect(appPosts.find((c) => c.body!.slug === "wordpress-blog")!.body!.provider).toBe(100);
    expect(appPosts.find((c) => c.body!.slug === "wordpress-blog-gate")!.body!.provider).toBe(101);

    // Outpost unioned with the new proxy pk, no duplicates.
    expect(state.outpostProviders).toEqual([1, 2, 3, 101]);

    // Secret minted once, persisted, returned — and long.
    const stored = store.written[baseInput.secretPath];
    expect(stored.clientSecret).toHaveLength(48);
    expect(result.oidc!.clientSecret).toBe(stored.clientSecret);
    expect(result.oidc!.clientId).toBe("wordpress-blog");
    expect(result.oidc!.issuer).toBe("https://auth.example.com/application/o/wordpress-blog/");
    expect(result.gated).toBe(true);
  });
});

describe("ensureSsoGate — idempotent update path", () => {
  test("PATCHes existing providers, reuses the stored secret, and skips a redundant outpost write", async () => {
    const state: ApiState = {
      oauthProviders: [{ pk: 100, name: "wordpress-blog" }],
      proxyProviders: [{ pk: 101, name: "wordpress-blog-gate" }],
      applications: [{ pk: "app-1", slug: "wordpress-blog" }, { pk: "app-2", slug: "wordpress-blog-gate" }],
      outpostProviders: [1, 101, 2], // proxy already registered
      nextPk: 500,
    };
    const { fetchMock, calls } = makeFetch(state);
    global.fetch = fetchMock as unknown as typeof fetch;
    const store = memoryStore({ clientId: "wordpress-blog", clientSecret: "kept-secret", issuer: "https://auth.example.com" });

    const result = await ensureSsoGate({ ...baseInput, mode: "both" }, store);

    expect(calls.some((c) => c.method === "POST")).toBe(false); // nothing created
    expect(calls.some((c) => c.path === "/api/v3/providers/oauth2/100/" && c.method === "PATCH")).toBe(true);
    expect(calls.some((c) => c.path === "/api/v3/providers/proxy/101/" && c.method === "PATCH")).toBe(true);
    expect(calls.some((c) => c.path.startsWith("/api/v3/outposts/") && c.method === "PATCH")).toBe(false);
    expect(result.oidc!.clientSecret).toBe("kept-secret"); // never rotated
    expect(Object.keys(store.written)).toHaveLength(0); // no re-write
  });
});

describe("ensureSsoGate — gate-only", () => {
  test("creates just the proxy provider (named by appSlug) and no OIDC creds", async () => {
    const state = emptyState();
    const { fetchMock, calls } = makeFetch(state);
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await ensureSsoGate(
      { host: "grafana.example.com", appSlug: "grafana", appName: "Grafana", mode: "gate" },
      memoryStore(),
    );

    expect(calls.some((c) => c.path === "/api/v3/providers/oauth2/" && c.method === "POST")).toBe(false);
    const proxyPost = calls.find((c) => c.path === "/api/v3/providers/proxy/" && c.method === "POST")!;
    expect(proxyPost.body!.external_host).toBe("https://grafana.example.com");
    const appPost = calls.find((c) => c.path === "/api/v3/core/applications/" && c.method === "POST")!;
    expect(appPost.body!.provider).toBe(100); // proxy is primary when gate-only
    expect(result.oidc).toBeUndefined();
    expect(result.gated).toBe(true);
    expect(state.outpostProviders).toContain(100);
  });
});

describe("removeSsoGate", () => {
  test("de-registers the proxy from the outpost and deletes the app + both providers", async () => {
    const state: ApiState = {
      oauthProviders: [{ pk: 100, name: "wordpress-blog" }],
      proxyProviders: [{ pk: 101, name: "wordpress-blog-gate" }],
      applications: [{ pk: "app-1", slug: "wordpress-blog" }, { pk: "app-2", slug: "wordpress-blog-gate" }],
      outpostProviders: [1, 101, 2],
      nextPk: 500,
    };
    const { fetchMock, calls } = makeFetch(state);
    global.fetch = fetchMock as unknown as typeof fetch;

    await removeSsoGate("wordpress-blog", "blog.example.com");

    expect(state.outpostProviders).toEqual([1, 2]); // 101 dropped
    expect(calls.some((c) => c.path === "/api/v3/core/applications/wordpress-blog/" && c.method === "DELETE")).toBe(true);
    expect(calls.some((c) => c.path === "/api/v3/core/applications/wordpress-blog-gate/" && c.method === "DELETE")).toBe(true);
    expect(calls.some((c) => c.path === "/api/v3/providers/proxy/101/" && c.method === "DELETE")).toBe(true);
    expect(calls.some((c) => c.path === "/api/v3/providers/oauth2/100/" && c.method === "DELETE")).toBe(true);
  });
});

describe("ensureSsoGate — guards", () => {
  test("requires a secretPath for oidc mode", async () => {
    global.fetch = makeFetch(emptyState()).fetchMock as unknown as typeof fetch;
    await expect(
      ensureSsoGate({ ...baseInput, mode: "oidc", secretPath: undefined }, memoryStore()),
    ).rejects.toThrow(/secretPath/);
  });
});
