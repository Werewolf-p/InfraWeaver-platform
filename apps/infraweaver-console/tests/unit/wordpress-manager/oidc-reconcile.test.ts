/** @jest-environment node */
// reconcileManagedOidc — the hourly fleet OIDC self-heal pass: checks each managed
// site, re-provisions the broken ones, and is fully isolated (one site's failure
// never sinks the pass).
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/addons/wordpress-manager/lib/iwsl-link-store", () => ({ listExternalSites: jest.fn() }));
jest.mock("@/addons/wordpress-manager/lib/iwsl-managed-ops", () => ({}));
jest.mock("@/addons/wordpress-manager/lib/provision", () => ({ validateSiteOidc: jest.fn() }));

import { reconcileManagedOidc } from "@/addons/wordpress-manager/lib/health-sweep";
import { validateSiteOidc } from "@/addons/wordpress-manager/lib/provision";

const validateMock = validateSiteOidc as jest.MockedFunction<typeof validateSiteOidc>;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("reconcileManagedOidc", () => {
  test("counts healthy, healed, unhealthy and errored sites — and heals only broken ones", async () => {
    validateMock.mockImplementation(async (site: string) => {
      if (site === "healthy") return { site, healthy: true, reason: "", reprovisioned: false };
      if (site === "healed") return { site, healthy: true, reason: "", reprovisioned: true };
      if (site === "stuck") return { site, healthy: false, reason: "client-id-empty", reprovisioned: true, error: "Authentik unavailable" };
      throw new Error("pod not ready");
    });

    const summary = await reconcileManagedOidc(["healthy", "healed", "stuck", "boom"]);

    expect(summary).toEqual({ checked: 4, healed: 1, unhealthy: 1, errored: 1 });
    // Every site was checked (isolation: the throwing one didn't stop the others).
    expect(validateMock).toHaveBeenCalledTimes(4);
    for (const s of ["healthy", "healed", "stuck", "boom"]) {
      expect(validateMock).toHaveBeenCalledWith(s, { reprovision: true });
    }
  });

  test("an empty fleet is a no-op", async () => {
    const summary = await reconcileManagedOidc([]);
    expect(summary).toEqual({ checked: 0, healed: 0, unhealthy: 0, errored: 0 });
    expect(validateMock).not.toHaveBeenCalled();
  });
});
