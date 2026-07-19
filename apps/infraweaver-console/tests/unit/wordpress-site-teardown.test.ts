/** @jest-environment node */
// §12.6 "Delete WordPress site" orchestration. The teardown composes a signed
// connector purge (step a), the cluster/DNS/secret teardown (steps b–e), and the
// link-record removal (step f) — this suite mocks those collaborators to assert
// the ORDER (purge before pod deletion, link record last), IDEMPOTENCY (absent
// resources are skipped, not failed), and PARTIAL-FAILURE tolerance (a failing
// step never strands the rest, and the aggregate `ok` flips to false).

import type { TeardownStep } from "@/addons/wordpress-manager/lib/teardown-step";

const calls: string[] = [];

const purgeConnectorEnrollment = jest.fn();
const deleteSite = jest.fn();
const getManagedLink = jest.fn();
const deleteExternalSite = jest.fn();

jest.mock("@/addons/wordpress-manager/lib/iwsl-managed-ops", () => ({
  purgeConnectorEnrollment: (...args: unknown[]) => {
    calls.push("purge");
    return purgeConnectorEnrollment(...args);
  },
}));
jest.mock("@/addons/wordpress-manager/lib/provision", () => ({
  deleteSite: (...args: unknown[]) => {
    calls.push("deleteSite");
    return deleteSite(...args);
  },
}));
jest.mock("@/addons/wordpress-manager/lib/iwsl-managed", () => ({
  getManagedLink: (...args: unknown[]) => getManagedLink(...args),
}));
jest.mock("@/addons/wordpress-manager/lib/iwsl-enrollment", () => ({
  deleteExternalSite: (...args: unknown[]) => {
    calls.push("deleteExternalSite");
    return deleteExternalSite(...args);
  },
}));

import { teardownSite } from "@/addons/wordpress-manager/lib/site-teardown";

const clusterSteps: TeardownStep[] = [
  { step: "deployment/blog", status: "removed" },
  { step: "pvc/blog-wp-data", status: "removed" },
  { step: "vault/db", status: "removed" },
];

function status(steps: TeardownStep[], name: string): string | undefined {
  return steps.find((s) => s.step === name)?.status;
}

beforeEach(() => {
  calls.length = 0;
  jest.clearAllMocks();
  deleteSite.mockResolvedValue(clusterSteps);
  getManagedLink.mockResolvedValue({ siteId: "sid-1", siteName: "blog", managed: true });
  deleteExternalSite.mockResolvedValue(undefined);
  purgeConnectorEnrollment.mockResolvedValue({ purged: true });
});

describe("teardownSite ordering", () => {
  test("purges the connector FIRST (pod still reachable), removes the link record LAST", async () => {
    const result = await teardownSite("blog");

    // Signed purge must precede pod/PVC deletion; link record must come after it.
    expect(calls).toEqual(["purge", "deleteSite", "deleteExternalSite"]);
    expect(result.ok).toBe(true);
    expect(status(result.steps, "connector-purge")).toBe("removed");
    expect(status(result.steps, "link-record")).toBe("removed");
    // The cluster steps from deleteSite are spliced in between.
    expect(status(result.steps, "pvc/blog-wp-data")).toBe("removed");
    expect(deleteExternalSite).toHaveBeenCalledWith("sid-1");
  });
});

describe("teardownSite idempotency", () => {
  test("a site with no connector link skips purge and link-record, still succeeds", async () => {
    getManagedLink.mockResolvedValue(null);
    purgeConnectorEnrollment.mockResolvedValue({ purged: false, skipped: "no connector link" });

    const result = await teardownSite("blog");

    expect(status(result.steps, "connector-purge")).toBe("skipped");
    expect(status(result.steps, "link-record")).toBe("skipped");
    expect(deleteExternalSite).not.toHaveBeenCalled();
    // Skipped is a clean idempotent no-op, not a failure.
    expect(result.ok).toBe(true);
  });

  test("an unreachable pod skips the signed purge without failing the teardown", async () => {
    purgeConnectorEnrollment.mockResolvedValue({ purged: false, skipped: "pod unreachable — signed purge skipped" });

    const result = await teardownSite("blog");

    expect(status(result.steps, "connector-purge")).toBe("skipped");
    expect(calls).toContain("deleteSite");
    expect(result.ok).toBe(true);
  });
});

describe("teardownSite partial-failure tolerance", () => {
  test("a failed cluster step does not strand the link-record removal", async () => {
    deleteSite.mockResolvedValue([
      { step: "pvc/blog-wp-data", status: "failed", detail: "boom" },
      { step: "vault/db", status: "removed" },
    ]);

    const result = await teardownSite("blog");

    // The teardown continued to step f despite the earlier failure…
    expect(calls).toEqual(["purge", "deleteSite", "deleteExternalSite"]);
    expect(status(result.steps, "link-record")).toBe("removed");
    // …but the aggregate result reports the failure so the operator can retry.
    expect(result.ok).toBe(false);
  });

  test("a throwing purge becomes a failed step, later steps still run", async () => {
    purgeConnectorEnrollment.mockRejectedValue(new Error("exec died"));

    const result = await teardownSite("blog");

    expect(status(result.steps, "connector-purge")).toBe("failed");
    expect(calls).toContain("deleteSite");
    expect(calls).toContain("deleteExternalSite");
    expect(result.ok).toBe(false);
  });

  test("a hard failure inside deleteSite is captured as one failed step, link record still removed", async () => {
    deleteSite.mockRejectedValue(new Error("no kubeconfig"));

    const result = await teardownSite("blog");

    expect(status(result.steps, "cluster-teardown")).toBe("failed");
    expect(status(result.steps, "link-record")).toBe("removed");
    expect(result.ok).toBe(false);
  });
});
