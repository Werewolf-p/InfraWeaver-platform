// OpenBao-backed NAS provider registry. Verifies the KV v2 read/write contract,
// 404 → empty degradation, credential-preserving upsert, and defensive salvage
// of malformed rows. global.fetch stands in for the OpenBao HTTP API.

import {
  readStoredNasProviders,
  writeStoredNasProviders,
  upsertStoredNasProvider,
  deleteStoredNasProvider,
  type StoredNasProvider,
} from "@/lib/nas/store";

const SYNO: StoredNasProvider = {
  id: "media-nas",
  name: "Media NAS",
  host: "10.25.0.21",
  port: 5001,
  protocol: "https",
  kind: "synology",
  backends: ["smb"],
  credentials: { username: "svc", password: "secret" },
};

function vaultResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return { ok: init.ok ?? true, status: init.status ?? 200, json: async () => body } as Response;
}

describe("nas store (OpenBao registry)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.OPENBAO_ADDR = "https://openbao.test";
    process.env.OPENBAO_TOKEN = "test-token";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    delete process.env.OPENBAO_ADDR;
    delete process.env.OPENBAO_TOKEN;
  });

  it("returns [] when the secret does not exist (404)", async () => {
    global.fetch = jest.fn().mockResolvedValue(vaultResponse(null, { ok: false, status: 404 }));
    await expect(readStoredNasProviders()).resolves.toEqual([]);
  });

  it("reads and validates stored providers", async () => {
    global.fetch = jest.fn().mockResolvedValue(vaultResponse({ data: { data: { providers: [SYNO] } } }));
    const providers = await readStoredNasProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].id).toBe("media-nas");
    expect(providers[0].credentials.password).toBe("secret");
  });

  it("drops malformed rows but keeps valid ones", async () => {
    const bad = { id: "BAD ID", name: "", host: "", port: 0 };
    global.fetch = jest.fn().mockResolvedValue(vaultResponse({ data: { data: { providers: [SYNO, bad] } } }));
    const providers = await readStoredNasProviders();
    expect(providers.map((p) => p.id)).toEqual(["media-nas"]);
  });

  it("sends X-Vault-Token and posts the whole list on write", async () => {
    const fetchMock = jest.fn().mockResolvedValue(vaultResponse({}, { ok: true }));
    global.fetch = fetchMock;
    await writeStoredNasProviders([SYNO]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v1/secret/data/platform/nas/providers");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Vault-Token"]).toBe("test-token");
    expect(JSON.parse(init.body as string)).toEqual({ data: { providers: [SYNO] } });
  });

  it("upsert preserves stored credentials when the incoming entry omits them", async () => {
    const fetchMock = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      if ((init.method ?? "GET") === "GET") {
        return Promise.resolve(vaultResponse({ data: { data: { providers: [SYNO] } } }));
      }
      return Promise.resolve(vaultResponse({}, { ok: true }));
    });
    global.fetch = fetchMock;

    await upsertStoredNasProvider({ ...SYNO, name: "Renamed", credentials: {} });

    const postCall = fetchMock.mock.calls.find((c) => (c[1].method ?? "GET") === "POST");
    const written = JSON.parse(postCall![1].body as string).data.providers[0] as StoredNasProvider;
    expect(written.name).toBe("Renamed");
    // Blank credentials in the update must not wipe the stored password.
    expect(written.credentials.password).toBe("secret");
  });

  it("delete removes a row and reports whether anything changed", async () => {
    const fetchMock = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      if ((init.method ?? "GET") === "GET") {
        return Promise.resolve(vaultResponse({ data: { data: { providers: [SYNO] } } }));
      }
      return Promise.resolve(vaultResponse({}, { ok: true }));
    });
    global.fetch = fetchMock;
    await expect(deleteStoredNasProvider("media-nas")).resolves.toBe(true);

    const fetchMock2 = jest.fn().mockResolvedValue(vaultResponse({ data: { data: { providers: [] } } }));
    global.fetch = fetchMock2;
    await expect(deleteStoredNasProvider("nope")).resolves.toBe(false);
  });
});
