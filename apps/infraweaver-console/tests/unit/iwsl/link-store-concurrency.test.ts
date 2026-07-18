/** @jest-environment node */
/**
 * §12.5 optimistic-concurrency guard for the IWSL sites ConfigMap.
 *
 * The hourly health sweep persists every fleet site's result through
 * `mutateExternalSites` in near-lockstep, so two writers routinely race on the
 * single `infraweaver-iwsl-sites` ConfigMap. These tests pin the core invariant:
 * a concurrent replace that lands between our read and our write forces a 409,
 * and the retry must RE-READ the latest resourceVersion and merge onto it —
 * never clobber the racing writer's record with our stale copy.
 */
jest.mock("server-only", () => ({}), { virtual: true });

interface FakeConfigMap {
  rv: number;
  sites: Array<{ siteId: string }>;
}

const mockState: {
  cm: FakeConfigMap;
  reads: number;
  replaces: number;
  /** One-shot: the next replace loses a race to a writer that appends this. */
  injectConflictOnce: boolean;
  concurrentRecord: { siteId: string } | null;
  /** Every replace throws 409 (exhaustion path). */
  alwaysConflict: boolean;
  /** One-shot: the next replace throws this non-conflict HTTP status. */
  failNextStatus: number | null;
  /** One-shot: the next replace throws a transient socket/network error. */
  injectWriteSocketErrorOnce: boolean;
  /** One-shot: the next read throws a transient socket/network error. */
  injectReadSocketErrorOnce: boolean;
} = {
  cm: { rv: 1, sites: [] },
  reads: 0,
  replaces: 0,
  injectConflictOnce: false,
  concurrentRecord: null,
  alwaysConflict: false,
  failNextStatus: null,
  injectWriteSocketErrorOnce: false,
  injectReadSocketErrorOnce: false,
};

function k8sError(message: string, code: number): Error {
  return Object.assign(new Error(message), { code });
}

/** A node-fetch-style transient network error (no HTTP status), like the live flap. */
function socketError(): Error {
  return Object.assign(
    new Error(
      "request to https://10.96.0.1/api/v1/namespaces/infraweaver-console/configmaps/infraweaver-iwsl-sites failed, reason: socket hang up",
    ),
    { code: "ECONNRESET", type: "system" },
  );
}

const CONFLICT_MESSAGE =
  'Operation cannot be fulfilled on configmaps "infraweaver-iwsl-sites": the object has been modified; 409 Conflict';

const mockCore = {
  readNamespacedConfigMap: jest.fn(async () => {
    mockState.reads += 1;
    if (mockState.injectReadSocketErrorOnce) {
      mockState.injectReadSocketErrorOnce = false;
      throw socketError();
    }
    return {
      metadata: { resourceVersion: String(mockState.cm.rv) },
      data: { sites: JSON.stringify(mockState.cm.sites) },
    };
  }),
  replaceNamespacedConfigMap: jest.fn(async ({ body }: { body: { metadata: { resourceVersion?: string }; data: { sites: string } } }) => {
    mockState.replaces += 1;

    if (mockState.injectWriteSocketErrorOnce) {
      mockState.injectWriteSocketErrorOnce = false;
      throw socketError();
    }
    if (mockState.failNextStatus !== null) {
      const status = mockState.failNextStatus;
      mockState.failNextStatus = null;
      throw k8sError(`Internal error: HTTP ${status}`, status);
    }
    if (mockState.alwaysConflict) {
      // Someone else keeps winning the race; our optimistic replace is always stale.
      mockState.cm = { rv: mockState.cm.rv + 1, sites: mockState.cm.sites };
      throw k8sError(CONFLICT_MESSAGE, 409);
    }
    if (mockState.injectConflictOnce) {
      mockState.injectConflictOnce = false;
      // A racing writer COMMITS FIRST: it appends its own record and bumps rv,
      // making the in-flight replace below stale.
      mockState.cm = {
        rv: mockState.cm.rv + 1,
        sites: [...mockState.cm.sites, mockState.concurrentRecord!],
      };
      throw k8sError(CONFLICT_MESSAGE, 409);
    }

    const incomingRv = Number(body.metadata.resourceVersion);
    if (incomingRv !== mockState.cm.rv) {
      throw k8sError(`409 Conflict: stale resourceVersion ${incomingRv} != ${mockState.cm.rv}`, 409);
    }
    mockState.cm = { rv: mockState.cm.rv + 1, sites: JSON.parse(body.data.sites) };
    return {};
  }),
  createNamespacedConfigMap: jest.fn(async ({ body }: { body: { data: { sites: string } } }) => {
    mockState.replaces += 1;
    mockState.cm = { rv: mockState.cm.rv + 1, sites: JSON.parse(body.data.sites) };
    return {};
  }),
};

jest.mock("@/lib/kube-client", () => ({ makeCoreApi: () => mockCore }));

import {
  mutateExternalSites,
  type ExternalSiteRecord,
} from "@/addons/wordpress-manager/lib/iwsl-link-store";

/** Minimal-but-typed record; only `siteId` matters to these tests. */
function rec(siteId: string): ExternalSiteRecord {
  return {
    siteId,
    name: siteId,
    url: `https://${siteId}.example.com`,
    state: "active",
    fingerprintConfirmed: true,
    createdAt: "2026-07-18T00:00:00.000Z",
    createdBy: "test",
    kid: 1,
    epochFloor: 1,
    iwKid: 1,
    rejections: 0,
  };
}

const ids = (sites: Array<{ siteId: string }>): string[] => sites.map((s) => s.siteId);

beforeEach(() => {
  mockState.cm = { rv: 1, sites: [rec("seed")] };
  mockState.reads = 0;
  mockState.replaces = 0;
  mockState.injectConflictOnce = false;
  mockState.concurrentRecord = null;
  mockState.alwaysConflict = false;
  mockState.failNextStatus = null;
  mockState.injectWriteSocketErrorOnce = false;
  mockState.injectReadSocketErrorOnce = false;
  mockCore.readNamespacedConfigMap.mockClear();
  mockCore.replaceNamespacedConfigMap.mockClear();
});

describe("mutateExternalSites — optimistic concurrency", () => {
  test("persists in a single read+replace when nothing races (attempts:1)", async () => {
    const result = await mutateExternalSites((sites) => {
      sites.push(rec("ours"));
      return sites.length;
    });

    expect(result).toBe(2);
    expect(mockState.reads).toBe(1);
    expect(mockState.replaces).toBe(1);
    expect(ids(mockState.cm.sites)).toEqual(["seed", "ours"]);
  });

  test("retries on a concurrent 409 replace and MERGES instead of clobbering", async () => {
    // Arrange: the first replace loses a race to a writer appending "concurrent".
    mockState.injectConflictOnce = true;
    mockState.concurrentRecord = rec("concurrent");

    // Act: our mutation appends "ours".
    const result = await mutateExternalSites((sites) => {
      sites.push(rec("ours"));
      return sites.length;
    });

    // Assert: retried once — re-read the racing writer's state, then merged onto it.
    expect(mockState.reads).toBe(2);
    expect(mockState.replaces).toBe(2);
    // The racing writer's record survives AND ours landed — no last-writer-wins clobber.
    expect(ids(mockState.cm.sites)).toEqual(["seed", "concurrent", "ours"]);
    // Mutator ran against the freshly-read 2-site list, so it returned 3.
    expect(result).toBe(3);
  });

  test("gives up after MUTATE_MAX_ATTEMPTS persistent conflicts", async () => {
    mockState.alwaysConflict = true;

    await expect(
      mutateExternalSites((sites) => sites.push(rec("ours"))),
    ).rejects.toThrow(/409|conflict/i);

    // 3 attempts total (initial + 2 retries).
    expect(mockState.replaces).toBe(3);
    expect(mockState.reads).toBe(3);
  });

  test("retries a transient socket hangup on the WRITE and then succeeds", async () => {
    // The live flap: the kube-apiserver drops the connection mid-replace.
    mockState.injectWriteSocketErrorOnce = true;

    const result = await mutateExternalSites((sites) => {
      sites.push(rec("ours"));
      return sites.length;
    });

    expect(result).toBe(2);
    expect(mockState.replaces).toBe(2); // first replace threw, retry landed
    expect(mockState.reads).toBe(2);
    expect(ids(mockState.cm.sites)).toEqual(["seed", "ours"]);
  });

  test("retries a transient socket hangup on the READ and then succeeds", async () => {
    mockState.injectReadSocketErrorOnce = true;

    const result = await mutateExternalSites((sites) => {
      sites.push(rec("ours"));
      return sites.length;
    });

    expect(result).toBe(2);
    // First attempt died in readSites (before any replace); retry read+wrote.
    expect(mockState.reads).toBe(2);
    expect(mockState.replaces).toBe(1);
    expect(ids(mockState.cm.sites)).toEqual(["seed", "ours"]);
  });

  test("propagates a non-conflict error immediately without retrying", async () => {
    mockState.failNextStatus = 500;

    await expect(
      mutateExternalSites((sites) => sites.push(rec("ours"))),
    ).rejects.toThrow(/500/);

    // No retry on a non-409 error.
    expect(mockState.replaces).toBe(1);
    expect(mockState.reads).toBe(1);
  });
});
