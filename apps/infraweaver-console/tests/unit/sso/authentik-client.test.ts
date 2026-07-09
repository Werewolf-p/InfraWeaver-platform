import { AuthentikClient } from "@/lib/sso/authentik-client";

/**
 * Focused tests for embedded-outpost membership. The regression these guard: a
 * proxy provider that is an application's primary provider but is MISSING from the
 * embedded outpost — the exact state that makes Authentik answer forward-auth with
 * "Not Found — Powered by authentik". `ensureProviderOnOutpost` must (1) guarantee
 * the provider in hand is attached, (2) heal any other app-primary proxy that has
 * drifted off the outpost, and (3) be additive (never drop a pk it does not own),
 * so two concurrent runs converge instead of clobbering each other.
 */
interface ApiState {
  outpostProviders: number[];
  proxyProviders: { pk: number; name: string; assigned_application_slug: string | null }[];
  patches: number[][];
}

function makeFetch(state: ApiState) {
  const json = (data: unknown, status = 200) =>
    Promise.resolve({ ok: status < 400, status, json: async () => data } as Response);

  const fetchMock = jest.fn((input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace("http://authentik.test", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;

    if (path.startsWith("/api/v3/outposts/instances/") && method === "GET") {
      return json({ results: [{ pk: "op-1", name: "authentik Embedded Outpost", type: "proxy", managed: "goauthentik.io/outposts/embedded", providers: state.outpostProviders }] });
    }
    if (path.startsWith("/api/v3/outposts/instances/") && method === "PATCH") {
      state.outpostProviders = body!.providers as number[];
      state.patches.push(state.outpostProviders);
      return json({});
    }
    if (path.startsWith("/api/v3/providers/proxy/") && method === "GET") {
      // Single page (no pagination.next) — mirrors this instance at current scale.
      return json({ results: state.proxyProviders });
    }
    throw new Error(`unrouted ${method} ${path}`);
  });
  return fetchMock;
}

beforeEach(() => {
  process.env.AUTHENTIK_URL = "http://authentik.test";
  process.env.AUTHENTIK_TOKEN = "test-token";
});
afterEach(() => jest.restoreAllMocks());

describe("AuthentikClient.ensureProviderOnOutpost", () => {
  test("attaches the provider in hand and heals a drifted app-primary proxy in one PATCH", async () => {
    const state: ApiState = {
      outpostProviders: [1, 2],
      proxyProviders: [
        { pk: 5, name: "wordpress-hi2-gate", assigned_application_slug: "wordpress-hi2-gate" }, // drifted off outpost
        { pk: 8, name: "backchannel", assigned_application_slug: null }, // not a primary → ignored
      ],
      patches: [],
    };
    global.fetch = makeFetch(state) as unknown as typeof fetch;

    await AuthentikClient.fromEnv().ensureProviderOnOutpost(9);

    // Additive union of {existing 1,2} ∪ {app-primary 5} ∪ {in-hand 9}; backchannel 8 excluded.
    expect(new Set(state.outpostProviders)).toEqual(new Set([1, 2, 5, 9]));
    expect(state.patches).toHaveLength(1);
  });

  test("is a no-op when the provider and every app-primary proxy are already attached", async () => {
    const state: ApiState = {
      outpostProviders: [1, 2, 5],
      proxyProviders: [{ pk: 5, name: "already", assigned_application_slug: "already" }],
      patches: [],
    };
    global.fetch = makeFetch(state) as unknown as typeof fetch;

    await AuthentikClient.fromEnv().ensureProviderOnOutpost(5);

    expect(state.patches).toHaveLength(0);
  });

  test("never drops providers it does not own (unmanaged pks survive)", async () => {
    const state: ApiState = {
      outpostProviders: [100, 101], // GitOps-managed forward-auth services, unknown to this console
      proxyProviders: [],
      patches: [],
    };
    global.fetch = makeFetch(state) as unknown as typeof fetch;

    await AuthentikClient.fromEnv().ensureProviderOnOutpost(7);

    expect(new Set(state.outpostProviders)).toEqual(new Set([100, 101, 7]));
  });
});
