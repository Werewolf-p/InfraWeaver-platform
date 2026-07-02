import { ensureAppAccessGroup, syncAppAccessMembers, removeAppAccessGroup } from "@/lib/sso/access";

/**
 * Live-shape Authentik API fakery for the access-group capability. Answers the GET
 * lookups (groups, applications, policy bindings, users) and records mutations so a
 * test can assert group create-vs-reuse, application binding, exact-set membership,
 * and teardown without a real Authentik.
 */
interface ApiState {
  groups: { pk: string; name: string }[];
  applications: { pk: string; slug: string }[];
  bindings: { pk: string; group: string | null; target: string }[];
  users: { pk: number; username: string }[];
  nextGroupPk: number;
  nextBindingPk: number;
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
    if (path.startsWith("/api/v3/core/groups/?search=") && method === "GET") {
      const q = new URL(url).searchParams.get("search")!;
      return json({ results: state.groups.filter((g) => g.name.includes(q)) });
    }
    if (path.startsWith("/api/v3/core/applications/?search=") && method === "GET") {
      const q = new URL(url).searchParams.get("search")!;
      return json({ results: state.applications.filter((a) => a.slug.includes(q)) });
    }
    if (path.startsWith("/api/v3/policies/bindings/?target=") && method === "GET") {
      const target = new URL(url).searchParams.get("target")!;
      return json({ results: state.bindings.filter((b) => b.target === target) });
    }
    if (path.startsWith("/api/v3/core/users/?username=") && method === "GET") {
      const q = new URL(url).searchParams.get("username")!;
      return json({ results: state.users.filter((u) => u.username === q) });
    }

    // --- mutations ---
    if (path === "/api/v3/core/groups/" && method === "POST") {
      const pk = `g-${state.nextGroupPk++}`;
      state.groups.push({ pk, name: String(body!.name) });
      return json({ pk });
    }
    if (path === "/api/v3/policies/bindings/" && method === "POST") {
      const pk = `b-${state.nextBindingPk++}`;
      state.bindings.push({ pk, group: String(body!.group), target: String(body!.target) });
      return json({ pk });
    }
    if (path.startsWith("/api/v3/core/groups/") && method === "PATCH") {
      return json({});
    }
    if (path.startsWith("/api/v3/core/groups/") && method === "DELETE") {
      return json({});
    }
    throw new Error(`unrouted ${method} ${path}`);
  });

  return { fetchMock, calls };
}

beforeEach(() => {
  process.env.AUTHENTIK_URL = "http://authentik.test";
  process.env.AUTHENTIK_TOKEN = "test-token";
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("ensureAppAccessGroup", () => {
  test("creates the group and binds it to every existing application", async () => {
    const state: ApiState = {
      groups: [],
      applications: [
        { pk: "app-oidc", slug: "wordpress-blog" },
        { pk: "app-gate", slug: "wordpress-blog-gate" },
      ],
      bindings: [],
      users: [],
      nextGroupPk: 1,
      nextBindingPk: 1,
    };
    const { fetchMock, calls } = makeFetch(state);
    global.fetch = fetchMock as unknown as typeof fetch;

    const { groupPk } = await ensureAppAccessGroup({
      groupName: "wordpress-blog-access",
      appSlugs: ["wordpress-blog", "wordpress-blog-gate"],
    });

    expect(groupPk).toBe("g-1");
    const bindPosts = calls.filter((c) => c.path === "/api/v3/policies/bindings/" && c.method === "POST");
    expect(bindPosts).toHaveLength(2);
    expect(bindPosts.map((c) => c.body!.target).sort()).toEqual(["app-gate", "app-oidc"]);
    expect(bindPosts.every((c) => c.body!.group === "g-1" && c.body!.enabled === true)).toBe(true);
  });

  test("reuses an existing group and does not duplicate an existing binding", async () => {
    const state: ApiState = {
      groups: [{ pk: "g-9", name: "wordpress-blog-access" }],
      applications: [{ pk: "app-oidc", slug: "wordpress-blog" }],
      bindings: [{ pk: "b-1", group: "g-9", target: "app-oidc" }],
      users: [],
      nextGroupPk: 50,
      nextBindingPk: 50,
    };
    const { fetchMock, calls } = makeFetch(state);
    global.fetch = fetchMock as unknown as typeof fetch;

    const { groupPk } = await ensureAppAccessGroup({ groupName: "wordpress-blog-access", appSlugs: ["wordpress-blog"] });

    expect(groupPk).toBe("g-9");
    expect(calls.some((c) => c.method === "POST")).toBe(false); // nothing created
  });

  test("skips slugs whose application does not exist yet", async () => {
    const state: ApiState = {
      groups: [], applications: [], bindings: [], users: [], nextGroupPk: 1, nextBindingPk: 1,
    };
    const { fetchMock, calls } = makeFetch(state);
    global.fetch = fetchMock as unknown as typeof fetch;

    await ensureAppAccessGroup({ groupName: "wordpress-blog-access", appSlugs: ["wordpress-blog"] });
    expect(calls.some((c) => c.path === "/api/v3/policies/bindings/")).toBe(false);
  });
});

describe("syncAppAccessMembers", () => {
  test("sets group membership to exactly the resolved user pks and reports unknowns", async () => {
    const state: ApiState = {
      groups: [{ pk: "g-1", name: "wordpress-blog-access" }],
      applications: [],
      bindings: [],
      users: [{ pk: 10, username: "alice" }, { pk: 20, username: "bob" }],
      nextGroupPk: 5, nextBindingPk: 5,
    };
    const { fetchMock, calls } = makeFetch(state);
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await syncAppAccessMembers("wordpress-blog-access", ["alice", "bob", "ghost"]);

    expect(result.applied.sort()).toEqual(["alice", "bob"]);
    expect(result.unknown).toEqual(["ghost"]);
    const patch = calls.find((c) => c.path === "/api/v3/core/groups/g-1/" && c.method === "PATCH")!;
    expect((patch.body!.users as number[]).sort((a, b) => a - b)).toEqual([10, 20]);
  });

  test("revoking the last user empties the group (fail-closed)", async () => {
    const state: ApiState = {
      groups: [{ pk: "g-1", name: "wordpress-blog-access" }],
      applications: [], bindings: [], users: [], nextGroupPk: 5, nextBindingPk: 5,
    };
    const { fetchMock, calls } = makeFetch(state);
    global.fetch = fetchMock as unknown as typeof fetch;

    await syncAppAccessMembers("wordpress-blog-access", []);
    const patch = calls.find((c) => c.path === "/api/v3/core/groups/g-1/" && c.method === "PATCH")!;
    expect(patch.body!.users).toEqual([]);
  });
});

describe("removeAppAccessGroup", () => {
  test("deletes the group by pk", async () => {
    const state: ApiState = {
      groups: [{ pk: "g-7", name: "wordpress-blog-access" }],
      applications: [], bindings: [], users: [], nextGroupPk: 9, nextBindingPk: 9,
    };
    const { fetchMock, calls } = makeFetch(state);
    global.fetch = fetchMock as unknown as typeof fetch;

    await removeAppAccessGroup("wordpress-blog-access");
    expect(calls.some((c) => c.path === "/api/v3/core/groups/g-7/" && c.method === "DELETE")).toBe(true);
  });
});
