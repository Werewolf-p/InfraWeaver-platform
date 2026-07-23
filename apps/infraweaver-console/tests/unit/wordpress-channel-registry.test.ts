/** @jest-environment node */
// Runtime release board (channel-registry.ts). ConfigMap-backed, so the CM layer
// is mocked in-memory exactly as the link-store concurrency test mocks it, and
// the bundled-version seed is stubbed. Pins: seed defaults on first read, semver
// validation, the promote direction rule, and rollback.
jest.mock("server-only", () => ({}), { virtual: true });

interface FakeConfigMap {
  rv: number;
  channels: string | undefined;
}

const mockState: { cm: FakeConfigMap | null } = { cm: null };

function notFound(): Error {
  return Object.assign(new Error("configmaps not found"), { code: 404 });
}

const mockCore = {
  readNamespacedConfigMap: jest.fn(async () => {
    if (!mockState.cm) throw notFound();
    return {
      metadata: { resourceVersion: String(mockState.cm.rv) },
      data: { channels: mockState.cm.channels },
    };
  }),
  replaceNamespacedConfigMap: jest.fn(async ({ body }: { body: { metadata: { resourceVersion?: string }; data: { channels: string } } }) => {
    const incoming = Number(body.metadata.resourceVersion);
    if (!mockState.cm || incoming !== mockState.cm.rv) {
      throw Object.assign(new Error("409 Conflict"), { code: 409 });
    }
    mockState.cm = { rv: mockState.cm.rv + 1, channels: body.data.channels };
    return {};
  }),
  createNamespacedConfigMap: jest.fn(async ({ body }: { body: { data: { channels: string } } }) => {
    mockState.cm = { rv: 1, channels: body.data.channels };
    return {};
  }),
};

jest.mock("@/lib/kube-client", () => ({ makeCoreApi: () => mockCore }));
jest.mock("@/addons/wordpress-manager/lib/connector-package", () => ({
  buildConnectorPackage: jest.fn(async () => ({ zip: Buffer.from(""), version: "1.4.0", filename: "x.zip" })),
}));

import {
  getChannelRegistry,
  getChannelRegistryDetail,
  promoteChannel,
  rollbackChannel,
  setChannelVersion,
} from "@/addons/wordpress-manager/lib/channel-registry";

beforeEach(() => {
  mockState.cm = null;
  jest.clearAllMocks();
});

describe("channel-registry — seed defaults", () => {
  test("a fresh cluster seeds every channel to the bundled version, without writing", async () => {
    const registry = await getChannelRegistry();

    expect(registry).toEqual({ prod: "1.4.0", beta: "1.4.0", alpha: "1.4.0" });
    // A read must never persist — viewing the board needs no write permission.
    expect(mockCore.replaceNamespacedConfigMap).not.toHaveBeenCalled();
    expect(mockCore.createNamespacedConfigMap).not.toHaveBeenCalled();
  });

  test("detail seeds carry the system:default provenance", async () => {
    const detail = await getChannelRegistryDetail();
    expect(detail.beta).toEqual({ version: "1.4.0", updatedAt: "", updatedBy: "system:default" });
  });
});

describe("channel-registry — setChannelVersion", () => {
  test("pins a channel to a valid version, stamping actor + timestamp", async () => {
    const registry = await setChannelVersion("alpha", "1.6.0", "alice");

    expect(registry.alpha.version).toBe("1.6.0");
    expect(registry.alpha.updatedBy).toBe("alice");
    expect(registry.alpha.updatedAt).not.toBe("");
    // Un-touched channels keep the seed.
    expect(registry.prod.version).toBe("1.4.0");
    // Persisted: a subsequent read reflects it.
    expect((await getChannelRegistry()).alpha).toBe("1.6.0");
  });

  test("rejects a garbage version (fails the connector-version parse)", async () => {
    await expect(setChannelVersion("alpha", "not-a-version", "alice")).rejects.toMatchObject({ status: 400 });
    expect(mockCore.replaceNamespacedConfigMap).not.toHaveBeenCalled();
    expect(mockCore.createNamespacedConfigMap).not.toHaveBeenCalled();
  });
});

describe("channel-registry — promoteChannel (direction rule)", () => {
  test("alpha→beta copies alpha's version onto beta", async () => {
    await setChannelVersion("alpha", "1.6.0", "alice");
    const registry = await promoteChannel("alpha", "beta", "bob");

    expect(registry.beta.version).toBe("1.6.0");
    expect(registry.beta.updatedBy).toBe("bob");
    expect(registry.alpha.version).toBe("1.6.0"); // source unchanged
  });

  test("beta→prod copies beta's version onto prod", async () => {
    await setChannelVersion("beta", "1.5.0", "alice");
    const registry = await promoteChannel("beta", "prod", "bob");
    expect(registry.prod.version).toBe("1.5.0");
  });

  test.each([
    ["prod", "beta"],
    ["beta", "alpha"],
    ["alpha", "prod"],
    ["prod", "prod"],
  ])("rejects the disallowed promotion %s→%s", async (from, to) => {
    await expect(
      promoteChannel(from as "prod" | "beta" | "alpha", to as "prod" | "beta" | "alpha", "bob"),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("channel-registry — rollbackChannel", () => {
  test("pins a channel back to an explicit prior version (no direction rule)", async () => {
    await setChannelVersion("prod", "1.5.0", "alice");
    const registry = await rollbackChannel("prod", "1.4.0", "bob");

    expect(registry.prod.version).toBe("1.4.0");
    expect(registry.prod.updatedBy).toBe("bob");
  });

  test("rejects rolling back to a garbage version", async () => {
    await expect(rollbackChannel("prod", "junk!", "bob")).rejects.toMatchObject({ status: 400 });
  });
});
