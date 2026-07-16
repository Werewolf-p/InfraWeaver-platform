// The self-service queue persists to a ConfigMap. Here the ConfigMap store is
// replaced with an in-memory fake so the queue's create/list/get/update/dedupe/
// prune behaviour is tested in isolation from Kubernetes.

jest.mock("server-only", () => ({}), { virtual: true });

// A closure-backed fake ConfigMap store shared across the single store instance
// store.ts creates at import time. __reset() clears it between tests.
jest.mock("@/lib/configmap-store", () => {
  let data: unknown = null;
  return {
    __reset: () => { data = null; },
    createConfigMapJsonStore: () => ({
      load: async () => data,
      save: async (value: unknown) => { data = value; },
      mutate: async (fn: (current: unknown) => unknown | Promise<unknown>) => {
        const next = await fn(data);
        data = next;
        return next;
      },
    }),
  };
});

import * as configMapStore from "@/lib/configmap-store";
import {
  countOpenRequestsFor,
  createRequest,
  findPendingDuplicate,
  getRequest,
  listPendingRequests,
  listRequestsFor,
  pruneRequestList,
  updateRequestStatus,
} from "@/lib/self-service/store";
import type { SelfServiceRequest } from "@/lib/self-service/types";

const resetStore = (configMapStore as unknown as { __reset: () => void }).__reset;

beforeEach(() => {
  resetStore();
});

describe("self-service store — create / list / get", () => {
  it("creates a request and lists it for its requester (case-insensitive)", async () => {
    // Arrange / Act
    const created = await createRequest({
      type: "app-access",
      status: "pending",
      requestedBy: "Alice@Example.com",
      requestedByGroups: ["team"],
      payload: { roleId: "reader", scope: "/" },
    });

    // Assert
    expect(created.id).toBeTruthy();
    const mine = await listRequestsFor("alice@example.com");
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe(created.id);
  });

  it("does not list another user's requests", async () => {
    await createRequest({ type: "password-reset", status: "pending", requestedBy: "bob@x", requestedByGroups: [], payload: {} });
    expect(await listRequestsFor("carol@x")).toHaveLength(0);
  });

  it("getRequest returns the stored request by id", async () => {
    const created = await createRequest({ type: "password-reset", status: "pending", requestedBy: "bob@x", requestedByGroups: [], payload: {} });
    const fetched = await getRequest(created.id);
    expect(fetched?.id).toBe(created.id);
    expect(await getRequest("missing")).toBeNull();
  });
});

describe("self-service store — status updates", () => {
  it("updates decision fields immutably and reports pending count", async () => {
    // Arrange
    const created = await createRequest({ type: "app-access", status: "pending", requestedBy: "alice@x", requestedByGroups: [], payload: { roleId: "reader", scope: "/" } });
    expect(await countOpenRequestsFor("alice@x")).toBe(1);

    // Act
    const updated = await updateRequestStatus(created.id, { status: "approved", decidedBy: "admin@x", appliedSummary: "Granted Reader at /" });

    // Assert
    expect(updated?.status).toBe("approved");
    expect(updated?.appliedSummary).toBe("Granted Reader at /");
    expect(await countOpenRequestsFor("alice@x")).toBe(0);
    expect(await listPendingRequests()).toHaveLength(0);
  });

  it("returns null when updating an unknown id", async () => {
    expect(await updateRequestStatus("nope", { status: "denied" })).toBeNull();
  });
});

describe("self-service store — duplicate detection", () => {
  it("finds a still-pending duplicate by type + requester + target", async () => {
    await createRequest({ type: "app-access", status: "pending", requestedBy: "alice@x", requestedByGroups: [], payload: { roleId: "reader", scope: "/" } });

    const dup = await findPendingDuplicate({ type: "app-access", requestedBy: "alice@x", payload: { roleId: "reader", scope: "/" } });
    expect(dup).not.toBeNull();

    const different = await findPendingDuplicate({ type: "app-access", requestedBy: "alice@x", payload: { roleId: "editor", scope: "/" } });
    expect(different).toBeNull();
  });

  it("does not treat a decided request as a duplicate", async () => {
    const created = await createRequest({ type: "app-access", status: "pending", requestedBy: "alice@x", requestedByGroups: [], payload: { roleId: "reader", scope: "/" } });
    await updateRequestStatus(created.id, { status: "denied", decisionNote: "no" });

    const dup = await findPendingDuplicate({ type: "app-access", requestedBy: "alice@x", payload: { roleId: "reader", scope: "/" } });
    expect(dup).toBeNull();
  });
});

describe("pruneRequestList", () => {
  function req(overrides: Partial<SelfServiceRequest>): SelfServiceRequest {
    return {
      id: Math.random().toString(36).slice(2),
      type: "password-reset",
      status: "auto-applied",
      requestedBy: "u@x",
      requestedByGroups: [],
      payload: {},
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("auto-expires a pending request past its TTL to cancelled", () => {
    const stale = req({ status: "pending", createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() });
    const [pruned] = pruneRequestList([stale]);
    expect(pruned.status).toBe("cancelled");
    expect(pruned.decisionNote).toContain("TTL");
  });

  it("keeps a fresh pending request untouched", () => {
    const fresh = req({ status: "pending", createdAt: new Date().toISOString() });
    const [pruned] = pruneRequestList([fresh]);
    expect(pruned.status).toBe("pending");
  });

  it("bounds decided history while retaining all pending", () => {
    const pending = Array.from({ length: 3 }, () => req({ status: "pending" }));
    const decided = Array.from({ length: 250 }, (_, index) =>
      req({ status: "denied", createdAt: new Date(Date.now() - index * 1000).toISOString() }),
    );
    const pruned = pruneRequestList([...pending, ...decided]);
    const prunedPending = pruned.filter((request) => request.status === "pending");
    const prunedDecided = pruned.filter((request) => request.status !== "pending");
    expect(prunedPending).toHaveLength(3);
    expect(prunedDecided).toHaveLength(200);
  });
});
